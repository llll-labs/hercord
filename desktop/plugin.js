/**
 * Hercord — mini channels + chat for Hermes Desktop.
 * Disk/unified plugin: imports only @hermes/plugin-sdk, react, react/jsx-runtime.
 * No JSX syntax (use jsx/jsxs). No bundler.
 *
 * Layout: left-zone tab (SESSIONS | BOTS | HERCORD) holds the channel list;
 * the /hercord route is the chat thread + composer.
 */
import {
  host,
  ROUTES_AREA,
  PANES_AREA,
  useQuery,
  useQueryClient,
  queryClient,
  atom,
  useValue,
} from '@hermes/plugin-sdk';
import { jsx, jsxs } from 'react/jsx-runtime';
import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from 'react';

const QK = {
  health: ['hercord', 'health'],
  me: ['hercord', 'me'],
  channels: ['hercord', 'channels'],
  messages: (channelId) => ['hercord', 'messages', channelId],
};

let pluginCtx = null;

/** Shared selected-channel atom. Falls back if plugin-sdk has no nanostores `atom`. */
function createSelectedChannelAtom(initial) {
  if (typeof atom === 'function') return atom(initial);
  let selectedChannelId = initial;
  const listeners = new Set();
  const emit = () => {
    listeners.forEach((fn) => {
      try {
        fn(selectedChannelId);
      } catch {
        /* ignore listener errors */
      }
    });
  };
  return {
    get: () => selectedChannelId,
    set: (next) => {
      if (Object.is(next, selectedChannelId)) return;
      selectedChannelId = next;
      emit();
    },
    subscribe: (fn) => {
      listeners.add(fn);
      fn(selectedChannelId);
      return () => listeners.delete(fn);
    },
    listen: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

const $selectedChannel = createSelectedChannelAtom(null);

const useSelectedChannel =
  typeof useValue === 'function'
    ? function useSelectedChannelAtom() {
        return useValue($selectedChannel);
      }
    : function useSelectedChannelLocal() {
        const [id, setId] = useState(() =>
          typeof $selectedChannel.get === 'function' ? $selectedChannel.get() : null,
        );
        useEffect(() => {
          const sub =
            typeof $selectedChannel.listen === 'function'
              ? $selectedChannel.listen(setId)
              : typeof $selectedChannel.subscribe === 'function'
                ? $selectedChannel.subscribe(setId)
                : null;
          if (typeof $selectedChannel.get === 'function') setId($selectedChannel.get());
          return typeof sub === 'function' ? sub : undefined;
        }, []);
        return id;
      };

function selectChannel(id) {
  $selectedChannel.set(id);
  if (pluginCtx && pluginCtx.storage) pluginCtx.storage.set('lastChannelId', id);
}

function errMessage(err, fallback) {
  if (!err) return fallback;
  if (typeof err === 'string') return err;
  if (err.message) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return fallback;
  }
}

function invalidateKey(qc, key) {
  if (qc) qc.invalidateQueries({ queryKey: key });
  else if (queryClient) queryClient.invalidateQueries({ queryKey: key });
}

function FileThumb({ ctx, file }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    if (!file || !file.id) return undefined;
    const mime = (file.mime || '').toLowerCase();
    if (!mime.startsWith('image/')) return undefined;
    let cancelled = false;
    ctx
      .rest('/files/' + encodeURIComponent(file.id) + '/data')
      .then((d) => {
        if (!cancelled && d && d.data_url) setSrc(d.data_url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [ctx, file && file.id, file && file.mime]);
  if (src) {
    return jsx('img', {
      src,
      alt: file.filename || 'image',
      style: {
        display: 'block',
        maxWidth: 280,
        maxHeight: 220,
        marginTop: 6,
        borderRadius: 6,
        border: '1px solid var(--ui-border)',
      },
    });
  }
  return jsx('div', {
    className: 'mt-1 text-xs',
    style: { color: 'var(--ui-text-secondary)' },
    children: file.filename || 'attachment',
  });
}

function useHercordHealth(ctx) {
  const [backendDown, setBackendDown] = useState(false);
  const healthQuery = useQuery({
    queryKey: QK.health,
    queryFn: async () => {
      const data = await ctx.rest('/health');
      return data;
    },
    retry: 1,
    refetchInterval: 15000,
  });
  useEffect(() => {
    if (healthQuery.isError) setBackendDown(true);
    else if (healthQuery.data && healthQuery.data.ok) setBackendDown(false);
  }, [healthQuery.isError, healthQuery.data]);
  return { healthQuery, backendDown };
}

function useHercordUser(ctx, backendDown, healthOk) {
  const [user, setUser] = useState(null);
  useEffect(() => {
    if (backendDown || !healthOk) return;
    let cancelled = false;
    (async () => {
      try {
        const storedId = ctx.storage && ctx.storage.get('userId');
        let me;
        try {
          me = await ctx.rest('/me', {
            method: 'POST',
            body: { handle: 'local', display_name: 'local' },
          });
        } catch (e) {
          host.notifyError(e, 'Failed to create local user');
          return;
        }
        if (cancelled) return;
        const u = me.user || me;
        setUser(u);
        if (ctx.storage && u && u.id) ctx.storage.set('userId', u.id);
        if (storedId && u && storedId !== u.id) {
          // keep newest
        }
      } catch (e) {
        host.notifyError(e, 'Failed to load identity');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [backendDown, healthOk, ctx]);
  return user;
}

function useHercordSocket(ctx, backendDown, channelId) {
  const qc = useQueryClient ? useQueryClient() : null;
  const [socketAlive, setSocketAlive] = useState(false);
  useEffect(() => {
    if (!ctx.socket || backendDown) return undefined;
    let gotFrame = false;
    const dispose = ctx.socket('/events', (frame) => {
      gotFrame = true;
      setSocketAlive(true);
      const type = frame && frame.type;
      if (type === 'hello') return;
      if (type === 'channel') {
        invalidateKey(qc, QK.channels);
      } else if (type === 'message' || type === 'file') {
        const payload = frame.payload || {};
        const cid = payload.channel_id || channelId;
        invalidateKey(qc, QK.messages(cid));
      } else {
        invalidateKey(qc, ['hercord']);
      }
    });
    const timer = setTimeout(() => {
      if (!gotFrame) setSocketAlive(false);
    }, 2500);
    return () => {
      clearTimeout(timer);
      if (typeof dispose === 'function') dispose();
    };
  }, [ctx, backendDown, channelId, qc]);
  return socketAlive;
}

function backendDownView() {
  return jsx('div', {
    className: 'flex h-full items-center justify-center p-6 text-sm',
    style: { color: 'var(--ui-text-secondary)' },
    children:
      'Enable hercord backend: hermes plugins enable hercord && restart gateway/serve',
  });
}

/** Left-zone tab: channel list only. Named for ContribRender. */
function HercordChannelsPane() {
  const ctx = pluginCtx;
  const qc = useQueryClient ? useQueryClient() : null;
  const channelId = useSelectedChannel();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  const { healthQuery, backendDown } = useHercordHealth(ctx);
  const user = useHercordUser(
    ctx,
    backendDown,
    !!(healthQuery.data && healthQuery.data.ok),
  );
  const socketAlive = useHercordSocket(ctx, backendDown, channelId);

  const channelsQuery = useQuery({
    queryKey: QK.channels,
    enabled: !backendDown && !!user,
    queryFn: async () => {
      const data = await ctx.rest('/channels');
      return data.channels || data || [];
    },
    refetchInterval: socketAlive ? false : 5000,
  });

  const channels = channelsQuery.data || [];

  useEffect(() => {
    if (!channels.length) return;
    if (channelId && channels.some((c) => c.id === channelId)) return;
    const general = channels.find((c) => c.slug === 'general') || channels[0];
    if (general) selectChannel(general.id);
  }, [channels, channelId]);

  const createChannel = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const data = await ctx.rest('/channels', {
        method: 'POST',
        body: { name },
      });
      const ch = data.channel || data;
      setNewName('');
      setCreating(false);
      if (qc) await qc.invalidateQueries({ queryKey: QK.channels });
      else if (queryClient)
        await queryClient.invalidateQueries({ queryKey: QK.channels });
      else if (channelsQuery.refetch) await channelsQuery.refetch();
      if (ch && ch.id) {
        selectChannel(ch.id);
        host.navigate('/hercord');
      }
    } catch (e) {
      host.notifyError(e, errMessage(e, 'Failed to create channel'));
    }
  }, [newName, ctx, qc, channelsQuery]);

  if (!ctx || backendDown || healthQuery.isError) {
    return backendDownView();
  }

  return jsxs('div', {
    className: 'flex h-full w-full flex-col overflow-hidden',
    style: {
      background: 'var(--ui-bg-secondary, var(--ui-bg))',
      color: 'var(--ui-text)',
    },
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between px-3 py-2 text-xs font-medium',
        style: { color: 'var(--ui-text-tertiary)' },
        children: [
          jsx('span', { children: 'Channels' }),
          jsx('button', {
            type: 'button',
            className: 'rounded px-1.5 py-0.5 text-xs',
            style: {
              color: 'var(--ui-text)',
              background: 'var(--ui-bg-hover, transparent)',
            },
            onClick: () => setCreating((v) => !v),
            children: '+',
            title: 'New channel',
          }),
        ],
      }),
      creating
        ? jsxs('div', {
            className: 'flex gap-1 px-2 pb-2',
            children: [
              jsx('input', {
                className: 'min-w-0 flex-1 rounded border px-2 py-1 text-xs',
                style: {
                  background: 'var(--ui-bg)',
                  borderColor: 'var(--ui-border)',
                  color: 'var(--ui-text)',
                },
                placeholder: 'name',
                value: newName,
                onChange: (e) => setNewName(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === 'Enter') createChannel();
                },
              }),
              jsx('button', {
                type: 'button',
                className: 'rounded px-2 text-xs',
                style: {
                  background: 'var(--ui-accent, var(--ui-bg-hover))',
                  color: 'var(--ui-text)',
                },
                onClick: createChannel,
                children: 'Add',
              }),
            ],
          })
        : null,
      jsx('div', {
        className: 'flex-1 overflow-y-auto px-1 pb-2',
        children: channels.map((ch) =>
          jsx(
            'button',
            {
              type: 'button',
              className: 'mb-0.5 w-full rounded px-2 py-1.5 text-left text-sm',
              style: {
                background:
                  ch.id === channelId
                    ? 'var(--ui-bg-hover, var(--ui-border))'
                    : 'transparent',
                color: 'var(--ui-text)',
              },
              onClick: () => {
                selectChannel(ch.id);
                host.navigate('/hercord');
              },
              children: '#' + ch.slug,
            },
            ch.id,
          ),
        ),
      }),
      jsx('div', {
        className: 'border-t px-3 py-2 text-xs',
        style: {
          borderColor: 'var(--ui-border)',
          color: 'var(--ui-text-tertiary)',
        },
        children: user
          ? '@' + (user.handle || 'local')
          : healthQuery.isLoading
            ? '…'
            : 'no user',
      }),
    ],
  });
}

/** Main-pane chat: header, thread, composer. No channel list. */
function HercordChat() {
  const ctx = pluginCtx;
  const qc = useQueryClient ? useQueryClient() : null;
  const channelId = useSelectedChannel();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef(null);
  const fileRef = useRef(null);

  const { healthQuery, backendDown } = useHercordHealth(ctx);
  const user = useHercordUser(
    ctx,
    backendDown,
    !!(healthQuery.data && healthQuery.data.ok),
  );
  const socketAlive = useHercordSocket(ctx, backendDown, channelId);

  const channelsQuery = useQuery({
    queryKey: QK.channels,
    enabled: !backendDown && !!user,
    queryFn: async () => {
      const data = await ctx.rest('/channels');
      return data.channels || data || [];
    },
    refetchInterval: socketAlive ? false : 5000,
  });

  const channels = channelsQuery.data || [];

  const messagesQuery = useQuery({
    queryKey: QK.messages(channelId || ''),
    enabled: !backendDown && !!user && !!channelId,
    queryFn: async () => {
      const data = await ctx.rest(
        '/channels/' + encodeURIComponent(channelId) + '/messages?limit=80',
      );
      return data.messages || data || [];
    },
    refetchInterval: socketAlive ? false : 3000,
  });

  const messages = messagesQuery.data || [];

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, channelId]);

  const active = useMemo(
    () => channels.find((c) => c.id === channelId) || null,
    [channels, channelId],
  );

  const sendMessage = useCallback(async () => {
    const body = draft;
    if (!body.trim() || !user || !channelId || sending) return;
    setSending(true);
    try {
      await ctx.rest('/channels/' + encodeURIComponent(channelId) + '/messages', {
        method: 'POST',
        body: { body, user_id: user.id },
      });
      setDraft('');
      if (qc) qc.invalidateQueries({ queryKey: QK.messages(channelId) });
      else if (queryClient)
        queryClient.invalidateQueries({ queryKey: QK.messages(channelId) });
      else if (messagesQuery.refetch) await messagesQuery.refetch();
    } catch (e) {
      host.notifyError(e, errMessage(e, 'Failed to send'));
    } finally {
      setSending(false);
    }
  }, [draft, user, channelId, sending, ctx, qc, messagesQuery]);

  const onKeyDown = useCallback(
    (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    },
    [sendMessage],
  );

  const onAttach = useCallback(
    async (ev) => {
      const file = ev.target && ev.target.files && ev.target.files[0];
      if (!file || !user || !channelId) return;
      try {
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        // Hermes multipart upload only sends the file part; extra fields go
        // on the query string (see POST /files).
        const q = new URLSearchParams();
        q.set('uploader_id', user.id);
        q.set('channel_id', channelId);
        await ctx.rest('/files?' + q.toString(), {
          method: 'POST',
          upload: {
            filename: file.name,
            contentType: file.type || 'application/octet-stream',
            bytes,
          },
        });
        if (qc) qc.invalidateQueries({ queryKey: QK.messages(channelId) });
        else if (queryClient)
          queryClient.invalidateQueries({ queryKey: QK.messages(channelId) });
      } catch (e) {
        host.notifyError(
          e,
          errMessage(e, 'Attach failed (upload may be unsupported)'),
        );
      } finally {
        if (fileRef.current) fileRef.current.value = '';
      }
    },
    [user, channelId, ctx, qc],
  );

  const voiceClick = useCallback(() => {
    if (host.notify) {
      host.notify({
        message: 'configure LIVEKIT_* to enable',
        title: 'Voice',
      });
    } else {
      host.notifyError(
        new Error('configure LIVEKIT_* to enable'),
        'configure LIVEKIT_* to enable',
      );
    }
  }, []);

  if (!ctx || backendDown || healthQuery.isError) {
    return backendDownView();
  }

  if (!channelId) {
    return jsx('div', {
      className: 'flex h-full items-center justify-center p-6 text-sm',
      style: { color: 'var(--ui-text-secondary)' },
      children: 'Pick a channel',
    });
  }

  return jsxs('section', {
    className: 'flex h-full min-w-0 w-full flex-col overflow-hidden',
    style: {
      background: 'var(--ui-bg)',
      color: 'var(--ui-text)',
    },
    children: [
      jsxs('header', {
        className: 'flex items-center justify-between border-b px-4 py-2',
        style: { borderColor: 'var(--ui-border)' },
        children: [
          jsx('div', {
            className: 'text-sm font-medium',
            children: active ? '#' + active.slug : 'Hercord',
          }),
          jsx('button', {
            type: 'button',
            className: 'rounded border px-2 py-1 text-xs opacity-60',
            style: {
              borderColor: 'var(--ui-border)',
              color: 'var(--ui-text-tertiary)',
            },
            onClick: voiceClick,
            disabled: true,
            title: 'Voice not configured',
            children: 'Voice',
          }),
        ],
      }),
      jsx('div', {
        ref: listRef,
        className: 'flex-1 overflow-y-auto px-4 py-3',
        children:
          messages.length === 0
            ? jsx('div', {
                className: 'text-sm',
                style: { color: 'var(--ui-text-tertiary)' },
                children: 'No messages yet. Say hello.',
              })
            : messages.map((m) =>
                jsxs(
                  'div',
                  {
                    className: 'mb-3',
                    children: [
                      jsxs('div', {
                        className: 'mb-0.5 flex items-baseline gap-2 text-xs',
                        style: { color: 'var(--ui-text-tertiary)' },
                        children: [
                          jsx('span', {
                            className: 'font-medium',
                            style: { color: 'var(--ui-text)' },
                            children: m.display_name || m.handle || 'user',
                          }),
                          jsx('span', {
                            children: m.created_at
                              ? new Date(m.created_at * 1000).toLocaleTimeString()
                              : '',
                          }),
                        ],
                      }),
                      jsx('div', {
                        className: 'whitespace-pre-wrap break-words text-sm',
                        children: m.file ? '' : m.body || '',
                      }),
                      m.file ? jsx(FileThumb, { ctx, file: m.file }) : null,
                    ],
                  },
                  m.id,
                ),
              ),
      }),
      jsxs('footer', {
        className: 'border-t p-3',
        style: { borderColor: 'var(--ui-border)' },
        children: [
          jsx('textarea', {
            className: 'mb-2 w-full resize-none rounded border px-3 py-2 text-sm',
            style: {
              minHeight: '64px',
              background: 'var(--ui-bg)',
              borderColor: 'var(--ui-border)',
              color: 'var(--ui-text)',
            },
            placeholder: active ? 'Message #' + active.slug : 'Select a channel',
            value: draft,
            disabled: !channelId || !user,
            onChange: (e) => setDraft(e.target.value),
            onKeyDown: onKeyDown,
          }),
          jsxs('div', {
            className: 'flex items-center gap-2',
            children: [
              jsx('input', {
                ref: fileRef,
                type: 'file',
                className: 'hidden',
                onChange: onAttach,
              }),
              jsx('button', {
                type: 'button',
                className: 'rounded border px-2 py-1 text-xs',
                style: {
                  borderColor: 'var(--ui-border)',
                  color: 'var(--ui-text-secondary, var(--ui-text))',
                },
                disabled: !channelId || !user,
                onClick: () => fileRef.current && fileRef.current.click(),
                children: 'Attach',
              }),
              jsx('div', { className: 'flex-1' }),
              jsx('button', {
                type: 'button',
                className: 'rounded px-3 py-1.5 text-sm font-medium',
                style: {
                  background: 'var(--ui-accent, var(--ui-bg-hover))',
                  color: 'var(--ui-accent-fg, var(--ui-text))',
                  opacity: !draft.trim() || sending ? 0.5 : 1,
                },
                disabled: !draft.trim() || !channelId || !user || sending,
                onClick: sendMessage,
                children: sending ? '…' : 'Send',
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

function HercordRoute() {
  return jsx(HercordChat, {});
}

export default {
  id: 'hercord',
  name: 'Hercord',
  description: 'Channels and chat inside Hermes Desktop',
  defaultEnabled: true,
  register(ctx) {
    pluginCtx = ctx;
    if (ctx.storage) {
      const last = ctx.storage.get('lastChannelId');
      if (last) $selectedChannel.set(last);
    }
    const routesArea = ROUTES_AREA || 'routes';
    const panesArea = PANES_AREA || 'panes';
    ctx.registerMany([
      {
        id: 'pane',
        area: panesArea,
        title: 'Hercord',
        data: {
          placement: 'left',
          width: '260px',
          collapsible: true,
          hideOnly: true,
          dock: { pane: 'sessions', pos: 'center', enforce: true },
        },
        render: HercordChannelsPane,
      },
      {
        id: 'page',
        area: routesArea,
        title: 'Hercord',
        data: { path: '/hercord' },
        render: HercordRoute,
      },
      {
        id: 'open',
        area: 'palette',
        data: {
          id: 'hercord.open',
          label: 'Hercord: Open',
          keywords: ['hercord', 'chat', 'channels'],
          run: () => host.navigate('/hercord'),
        },
      },
    ]);
    if (typeof host.paneVisibility === 'function') {
      const $vis = host.paneVisibility('hercord:pane');
      const unsub = $vis.subscribe((visible) => {
        const hash = (window.location.hash || '').replace(/^#/, '');
        if (visible) host.navigate('/hercord');
        else if (hash === '/hercord' || hash.startsWith('/hercord'))
          host.navigate('/new');
      });
      if (typeof ctx.onDispose === 'function') ctx.onDispose(unsub);
      else if (typeof ctx.dispose === 'function') ctx.dispose(unsub);
    }
    ctx
      .rest('/health')
      .then(() => {
        if (queryClient)
          queryClient.invalidateQueries({ queryKey: QK.health });
      })
      .catch(() => {});
  },
};
