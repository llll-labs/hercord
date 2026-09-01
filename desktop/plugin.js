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
        maxWidth: 360,
        maxHeight: 280,
        marginTop: 6,
        borderRadius: 8,
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


function avatarLetter(name) {
  const s = (name || '?').trim();
  return s ? s.charAt(0).toUpperCase() : '?';
}

function AvatarCircle({ label, size }) {
  const sz = size || 32;
  return jsx('div', {
    style: {
      width: sz,
      height: sz,
      borderRadius: '50%',
      flexShrink: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: Math.max(11, Math.round(sz * 0.4)),
      fontWeight: 600,
      background:
        'color-mix(in srgb, var(--ui-accent, #6c8cff) 22%, var(--ui-bg-secondary, transparent))',
      color: 'var(--ui-text)',
      userSelect: 'none',
    },
    'aria-hidden': true,
    children: avatarLetter(label),
  });
}

function sameMessageGroup(prev, curr) {
  if (!prev || !curr) return false;
  const a = prev.user_id || prev.handle || prev.display_name;
  const b = curr.user_id || curr.handle || curr.display_name;
  if (!a || a !== b) return false;
  const ta = prev.created_at;
  const tb = curr.created_at;
  if (ta == null || tb == null) return false;
  return Math.abs(tb - ta) <= 5 * 60;
}

function formatMsgTime(ts) {
  if (!ts) return '';
  try {
    return new Date(ts * 1000).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function HercordStyles() {
  return jsx('style', {
    children: [
      '.hercord-channel-row:hover:not(.hercord-channel-active){background:var(--ui-bg-hover)!important;}',
      '.hercord-msg-row:hover{background:var(--ui-bg-hover);}',
      '.hercord-focus:focus-visible{outline:2px solid var(--ui-accent);outline-offset:1px;}',
      '.hercord-composer-input:focus{outline:none;box-shadow:none;}',
      '.hercord-input:focus{outline:none;}',
      '.hercord-btn:disabled,.hercord-disabled{opacity:0.5;cursor:not-allowed;}',
      '.hercord-plus:hover{background:var(--ui-bg-hover)!important;}',
      '.hercord-attach:hover:not(:disabled){background:var(--chrome-action-hover,var(--ui-bg-hover))!important;color:var(--ui-text)!important;}',
      '.hercord-send:hover:not(:disabled){filter:brightness(1.08);}',
      '.hercord-send:disabled{opacity:0.45;cursor:not-allowed;}',
    ].join(''),
  });
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

  const handle = user && (user.handle || 'local');
  const displayName =
    (user && (user.display_name || user.handle)) ||
    (healthQuery.isLoading ? '…' : 'no user');

  return jsxs('div', {
    className: 'flex h-full w-full flex-col overflow-hidden',
    style: {
      background: 'var(--ui-bg-secondary, var(--ui-bg))',
      color: 'var(--ui-text)',
      fontSize: 14,
    },
    children: [
      jsx(HercordStyles, {}),
      jsxs('div', {
        className: 'flex items-center justify-between px-3',
        style: { paddingTop: 12, paddingBottom: 8 },
        children: [
          jsx('span', {
            style: {
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'var(--ui-text-tertiary, var(--ui-text-secondary))',
            },
            children: 'Channels',
          }),
          jsx('button', {
            type: 'button',
            className: 'hercord-plus hercord-focus',
            title: 'New channel',
            'aria-label': 'New channel',
            style: {
              width: 22,
              height: 22,
              borderRadius: '50%',
              border: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              fontSize: 16,
              lineHeight: 1,
              color: 'var(--ui-text-secondary)',
              background: 'transparent',
              padding: 0,
            },
            onClick: () => setCreating((v) => !v),
            children: '+',
          }),
        ],
      }),
      creating
        ? jsxs('div', {
            className: 'flex gap-1 px-2 pb-2',
            children: [
              jsx('input', {
                className: 'hercord-input min-w-0 flex-1',
                style: {
                  background: 'var(--ui-bg)',
                  border: '1px solid var(--ui-border)',
                  borderRadius: 6,
                  padding: '6px 8px',
                  fontSize: 12,
                  color: 'var(--ui-text)',
                },
                placeholder: 'channel-name',
                value: newName,
                onChange: (e) => setNewName(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === 'Enter') createChannel();
                },
              }),
              jsx('button', {
                type: 'button',
                className: 'hercord-focus hercord-btn',
                style: {
                  borderRadius: 6,
                  border: 'none',
                  padding: '6px 10px',
                  fontSize: 12,
                  cursor: 'pointer',
                  background: 'var(--ui-accent, var(--ui-bg-hover))',
                  color: 'var(--ui-accent-fg, var(--ui-text))',
                },
                onClick: createChannel,
                children: 'Add',
              }),
            ],
          })
        : null,
      jsxs('div', {
        className: 'flex-1 overflow-y-auto',
        style: { padding: '4px 8px 8px' },
        children: [
          jsx('div', {
            style: {
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: 'var(--ui-text-tertiary, var(--ui-text-secondary))',
              padding: '8px 10px 4px',
            },
            children: 'Text Channels',
          }),
          channels.map((ch) => {
            const active = ch.id === channelId;
            return jsx(
              'button',
              {
                type: 'button',
                className:
                  'hercord-channel-row hercord-focus' +
                  (active ? ' hercord-channel-active' : ''),
                style: {
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  border: 'none',
                  borderRadius: 7,
                  padding: '8px 10px',
                  marginBottom: 2,
                  cursor: 'pointer',
                  fontSize: 14,
                  background: active
                    ? 'var(--ui-bg-hover, var(--ui-bg-elevated, var(--ui-border)))'
                    : 'transparent',
                  color: active
                    ? 'var(--ui-text)'
                    : 'var(--ui-text-secondary, var(--ui-text))',
                  fontWeight: active ? 500 : 400,
                },
                onClick: () => {
                  selectChannel(ch.id);
                  host.navigate('/hercord');
                },
                children: '#' + ch.slug,
              },
              ch.id,
            );
          }),
        ],
      }),
      jsxs('div', {
        className: 'flex items-center gap-2',
        style: {
          padding: '10px 12px',
          borderTop: '1px solid var(--ui-border)',
          background: 'var(--ui-bg-secondary, var(--ui-bg))',
        },
        children: [
          jsx(AvatarCircle, {
            label: displayName,
            size: 28,
          }),
          jsxs('div', {
            className: 'min-w-0 flex-1',
            style: { lineHeight: 1.25 },
            children: [
              jsx('div', {
                style: {
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--ui-text)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
                children: displayName,
              }),
              jsx('div', {
                style: {
                  fontSize: 12,
                  color: 'var(--ui-text-tertiary, var(--ui-text-secondary))',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
                children: handle ? '@' + handle : '',
              }),
            ],
          }),
        ],
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
      className: 'flex h-full items-center justify-center p-6',
      style: { color: 'var(--ui-text-secondary)', fontSize: 14 },
      children: 'Pick a channel',
    });
  }

  const channelLabel = active ? '#' + active.slug : 'Hercord';
  const channelTopic =
    (active && (active.topic || active.description)) || null;

  return jsxs('section', {
    className: 'flex h-full min-w-0 w-full flex-col overflow-hidden',
    style: {
      background: 'var(--ui-bg)',
      color: 'var(--ui-text)',
      fontSize: 14,
    },
    children: [
      jsx(HercordStyles, {}),
      jsxs('header', {
        className: 'flex items-center justify-between',
        style: {
          padding: '10px 16px',
          borderBottom: '1px solid var(--ui-border)',
          minHeight: 48,
          gap: 12,
        },
        children: [
          jsxs('div', {
            className: 'min-w-0 flex-1',
            style: { lineHeight: 1.3 },
            children: [
              jsx('div', {
                style: {
                  fontSize: 15,
                  fontWeight: 600,
                  color: 'var(--ui-text)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
                children: channelLabel,
              }),
              channelTopic
                ? jsx('div', {
                    style: {
                      fontSize: 12,
                      color: 'var(--ui-text-tertiary, var(--ui-text-secondary))',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    },
                    children: channelTopic,
                  })
                : null,
            ],
          }),
          jsx('button', {
            type: 'button',
            className: 'hercord-focus hercord-btn',
            style: {
              borderRadius: 6,
              border: '1px solid var(--ui-border)',
              background: 'transparent',
              padding: '5px 10px',
              fontSize: 12,
              color: 'var(--ui-text-secondary)',
              cursor: 'pointer',
              opacity: 0.55,
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
        className: 'flex-1 overflow-y-auto',
        style: { padding: '16px 0' },
        children:
          messages.length === 0
            ? jsxs('div', {
                className: 'flex h-full flex-col items-center justify-center',
                style: {
                  color: 'var(--ui-text-tertiary, var(--ui-text-secondary))',
                  padding: 24,
                  textAlign: 'center',
                  gap: 6,
                },
                children: [
                  jsx('div', {
                    style: { fontSize: 18, fontWeight: 600, color: 'var(--ui-text)' },
                    children: 'Welcome to ' + channelLabel,
                  }),
                  jsx('div', {
                    style: { fontSize: 13 },
                    children: 'No messages yet…',
                  }),
                ],
              })
            : messages.map((m, i) => {
                const prev = i > 0 ? messages[i - 1] : null;
                const grouped = sameMessageGroup(prev, m);
                const author = m.display_name || m.handle || 'user';
                const time = formatMsgTime(m.created_at);
                return jsxs(
                  'div',
                  {
                    className: 'hercord-msg-row',
                    style: {
                      display: 'flex',
                      gap: 12,
                      padding: grouped ? '2px 16px 2px 16px' : '8px 16px',
                      marginTop: grouped ? 0 : 8,
                    },
                    children: [
                      jsx('div', {
                        style: {
                          width: 36,
                          flexShrink: 0,
                          paddingTop: 2,
                        },
                        children: grouped
                          ? null
                          : jsx(AvatarCircle, { label: author, size: 36 }),
                      }),
                      jsxs('div', {
                        className: 'min-w-0 flex-1',
                        children: [
                          grouped
                            ? null
                            : jsxs('div', {
                                className: 'flex items-baseline gap-2',
                                style: { marginBottom: 2, lineHeight: 1.3 },
                                children: [
                                  jsx('span', {
                                    style: {
                                      fontSize: 14,
                                      fontWeight: 600,
                                      color: 'var(--ui-text)',
                                    },
                                    children: author,
                                  }),
                                  jsx('span', {
                                    style: {
                                      fontSize: 12,
                                      color:
                                        'var(--ui-text-tertiary, var(--ui-text-secondary))',
                                    },
                                    children: time,
                                  }),
                                ],
                              }),
                          m.file
                            ? null
                            : jsx('div', {
                                style: {
                                  fontSize: 14,
                                  whiteSpace: 'pre-wrap',
                                  wordBreak: 'break-word',
                                  lineHeight: 1.4,
                                  color: 'var(--ui-text)',
                                },
                                children: m.body || '',
                              }),
                          m.file ? jsx(FileThumb, { ctx, file: m.file }) : null,
                        ],
                      }),
                    ],
                  },
                  m.id,
                );
              }),
      }),
      jsx('footer', {
        style: { padding: '12px 16px 16px', flexShrink: 0 },
        children: jsx('div', {
          className: 'hercord-composer',
          'data-slot': 'composer-root',
          style: {
            position: 'relative',
            borderRadius: 16,
            overflow: 'hidden',
          },
          children: jsxs('div', {
            'data-slot': 'composer-surface',
            style: {
              position: 'relative',
              borderRadius: 'inherit',
              border:
                '1px solid color-mix(in srgb, var(--dt-composer-ring, var(--ui-text)) 18%, var(--dt-input, var(--ui-border)))',
              overflow: 'hidden',
            },
            children: [
              jsx('div', {
                'aria-hidden': true,
                style: {
                  position: 'absolute',
                  inset: 0,
                  background:
                    'var(--composer-fill, color-mix(in srgb, var(--ui-bg-elevated, var(--ui-bg-secondary)) 90%, transparent))',
                  backdropFilter: 'blur(0.75rem) saturate(1.12)',
                  WebkitBackdropFilter: 'blur(0.75rem) saturate(1.12)',
                  pointerEvents: 'none',
                  zIndex: 0,
                },
              }),
              jsxs('div', {
                style: {
                  position: 'relative',
                  zIndex: 1,
                  display: 'flex',
                  alignItems: 'flex-end',
                  gap: '0.25rem',
                  padding: '0.3125rem 0.5rem',
                },
                children: [
                  jsx('input', {
                    ref: fileRef,
                    type: 'file',
                    className: 'hidden',
                    onChange: onAttach,
                  }),
                  jsx('button', {
                    type: 'button',
                    className: 'hercord-attach hercord-focus hercord-btn',
                    title: 'Attach',
                    'aria-label': 'Attach',
                    style: {
                      width: '1.5rem',
                      height: '1.5rem',
                      minWidth: '1.5rem',
                      borderRadius: 6,
                      border: 'none',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: 'transparent',
                      cursor: 'pointer',
                      padding: 0,
                      fontSize: 16,
                      fontWeight: 500,
                      lineHeight: 1,
                      color:
                        'var(--ui-text-tertiary, var(--ui-text-secondary))',
                      flexShrink: 0,
                      marginBottom: 2,
                    },
                    disabled: !channelId || !user,
                    onClick: () => fileRef.current && fileRef.current.click(),
                    children: '+',
                  }),
                  jsx('textarea', {
                    className: 'hercord-composer-input min-w-0 flex-1',
                    style: {
                      resize: 'none',
                      border: 'none',
                      outline: 'none',
                      boxShadow: 'none',
                      background: 'transparent',
                      color: 'var(--ui-text)',
                      fontSize: 14,
                      lineHeight: 1.4,
                      minHeight: '1.625rem',
                      maxHeight: '9.375rem',
                      padding: '0.25rem 0',
                      fontFamily: 'inherit',
                      width: '100%',
                      boxSizing: 'border-box',
                    },
                    rows: 1,
                    placeholder: active
                      ? 'Message #' + active.slug
                      : 'Select a channel',
                    value: draft,
                    disabled: !channelId || !user,
                    onChange: (e) => setDraft(e.target.value),
                    onKeyDown: onKeyDown,
                  }),
                  jsx('button', {
                    type: 'button',
                    className: 'hercord-send hercord-focus hercord-btn',
                    title: 'Send (Enter)',
                    'aria-label': 'Send',
                    style: {
                      width: '1.625rem',
                      height: '1.625rem',
                      minWidth: '1.625rem',
                      border: 'none',
                      borderRadius: 9999,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: 0,
                      fontSize: 14,
                      fontWeight: 600,
                      lineHeight: 1,
                      cursor: 'pointer',
                      flexShrink: 0,
                      background: 'var(--ui-text, #111)',
                      color: 'var(--ui-bg, #fff)',
                      opacity: !draft.trim() || sending ? 0.45 : 1,
                      marginBottom: 1,
                    },
                    disabled: !draft.trim() || !channelId || !user || sending,
                    onClick: sendMessage,
                    children: sending ? '…' : '↑',
                  }),
                ],
              }),
            ],
          }),
        }),
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
