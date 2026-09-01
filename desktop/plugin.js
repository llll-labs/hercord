/**
 * Hercord — mini channels + chat for Hermes Desktop.
 * Disk/unified plugin: imports only @hermes/plugin-sdk, react, react/jsx-runtime.
 * No JSX syntax (use jsx/jsxs). No bundler.
 */
import {
  host,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  useQuery,
  useQueryClient,
  queryClient,
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

function HercordPage({ ctx }) {
  const qc = useQueryClient ? useQueryClient() : null;
  const [backendDown, setBackendDown] = useState(false);
  const [user, setUser] = useState(null);
  const [channelId, setChannelId] = useState(
    () => (ctx.storage && ctx.storage.get('lastChannelId')) || null,
  );
  const [draft, setDraft] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [sending, setSending] = useState(false);
  const [socketAlive, setSocketAlive] = useState(false);
  const listRef = useRef(null);
  const fileRef = useRef(null);

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

  // Bootstrap identity after health
  useEffect(() => {
    if (backendDown || !healthQuery.data || !healthQuery.data.ok) return;
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
  }, [backendDown, healthQuery.data, ctx]);

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

  // Default to #general
  useEffect(() => {
    if (!channels.length) return;
    if (channelId && channels.some((c) => c.id === channelId)) return;
    const general = channels.find((c) => c.slug === 'general') || channels[0];
    if (general) {
      setChannelId(general.id);
      if (ctx.storage) ctx.storage.set('lastChannelId', general.id);
    }
  }, [channels, channelId, ctx]);

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

  // Live updates via ctx.socket; poll fallback when socket never fires
  useEffect(() => {
    if (!ctx.socket || backendDown) return undefined;
    let gotFrame = false;
    const dispose = ctx.socket('/events', (frame) => {
      gotFrame = true;
      setSocketAlive(true);
      const type = frame && frame.type;
      if (type === 'hello') return;
      if (type === 'channel') {
        if (qc) qc.invalidateQueries({ queryKey: QK.channels });
        else if (queryClient) queryClient.invalidateQueries({ queryKey: QK.channels });
        else channelsQuery.refetch && channelsQuery.refetch();
      } else if (type === 'message' || type === 'file') {
        const payload = frame.payload || {};
        const cid = payload.channel_id || channelId;
        if (qc) qc.invalidateQueries({ queryKey: QK.messages(cid) });
        else if (queryClient)
          queryClient.invalidateQueries({ queryKey: QK.messages(cid) });
        else messagesQuery.refetch && messagesQuery.refetch();
      } else {
        if (qc) {
          qc.invalidateQueries({ queryKey: ['hercord'] });
        } else if (queryClient) {
          queryClient.invalidateQueries({ queryKey: ['hercord'] });
        }
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

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, channelId]);

  const active = useMemo(
    () => channels.find((c) => c.id === channelId) || null,
    [channels, channelId],
  );

  const selectChannel = useCallback(
    (id) => {
      setChannelId(id);
      if (ctx.storage) ctx.storage.set('lastChannelId', id);
    },
    [ctx],
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
      if (ch && ch.id) selectChannel(ch.id);
    } catch (e) {
      host.notifyError(e, errMessage(e, 'Failed to create channel'));
    }
  }, [newName, ctx, qc, channelsQuery, selectChannel]);

  const onKeyDown = useCallback(
    (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    },
    [sendMessage],
  );

  const onAttach = useCallback(async (ev) => {
    const file = ev.target && ev.target.files && ev.target.files[0];
    if (!file || !user || !channelId) return;
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      await ctx.rest('/files', {
        method: 'POST',
        upload: {
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          bytes,
        },
        // Also try form fields if the host forwards them with upload
        body: {
          uploader_id: user.id,
          channel_id: channelId,
        },
      });
      if (qc) qc.invalidateQueries({ queryKey: QK.messages(channelId) });
      else if (queryClient)
        queryClient.invalidateQueries({ queryKey: QK.messages(channelId) });
    } catch (e) {
      // Graceful skip if upload wiring is awkward
      host.notifyError(e, errMessage(e, 'Attach failed (upload may be unsupported)'));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }, [user, channelId, ctx, qc]);

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

  if (backendDown || healthQuery.isError) {
    return jsx('div', {
      className: 'flex h-full items-center justify-center p-6 text-sm',
      style: { color: 'var(--ui-text-secondary)' },
      children:
        'Enable hercord backend: hermes plugins enable hercord && restart gateway/serve',
    });
  }

  return jsxs('div', {
    className: 'flex h-full w-full overflow-hidden',
    style: {
      background: 'var(--ui-bg)',
      color: 'var(--ui-text)',
    },
    children: [
      // Channel list
      jsxs('aside', {
        className: 'flex h-full flex-col border-r',
        style: {
          width: '220px',
          minWidth: '180px',
          borderColor: 'var(--ui-border)',
          background: 'var(--ui-bg-secondary, var(--ui-bg))',
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
                  onClick: () => selectChannel(ch.id),
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
      }),

      // Thread
      jsxs('section', {
        className: 'flex min-w-0 flex-1 flex-col',
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
                    children: channelId
                      ? 'No messages yet. Say hello.'
                      : 'Pick a channel.',
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
                            children: m.body || '',
                          }),
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
                placeholder: active
                  ? 'Message #' + active.slug
                  : 'Select a channel',
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
      }),
    ],
  });
}

export default {
  id: 'hercord',
  name: 'Hercord',
  defaultEnabled: true,
  register(ctx) {
    const dispose = ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: '/hercord' },
        render: () => jsx(HercordPage, { ctx }),
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        data: {
          path: '/hercord',
          label: 'Hercord',
          codicon: 'comment-discussion',
        },
      },
    ]);
    if (typeof ctx.onDispose === 'function' && typeof dispose === 'function') {
      ctx.onDispose(dispose);
    }
    // Warm health so the first paint can show the enable hint quickly
    ctx
      .rest('/health')
      .then(() => {
        if (queryClient)
          queryClient.invalidateQueries({ queryKey: QK.health });
      })
      .catch(() => {
        /* UI shows enable hint via useQuery error */
      });
  },
};
