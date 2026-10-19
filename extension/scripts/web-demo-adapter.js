(() => {
  'use strict';
  const sample = window.__ARC_DEMO_SAMPLES__;
  const ids = Object.keys(sample.payloads);
  let selected = ids[0];
  const placeRules = sample.placeRules;
  let trail = placeRules.visitPlace(placeRules.emptyTrail(), selected);
  let layout = { cardLayout: 'two-columns', promptPosition: 'above' };
  let views = sample.payloads[selected].views;
  let railFilters = sample.payloads[selected].railFilters;
  const pinnedTop = new Set(sample.payloads[selected].pinnedTop);
  const hidden = new Set(sample.payloads[selected].hidden);
  const unread = new Set(sample.payloads[selected].rail.filter((row) => row.unread).map((row) => row.id));
  const labelRules = sample.labelRules;
  const readRules = sample.readRules;
  let labels = sample.labels;
  let browserState = null;
  let comments = sample.commentRules.normalizeComments(
    Object.values(sample.payloads).flatMap((payload) => payload.comments),
  );
  // Initialize turn read marks to match session unread state. Saves then derive session unread state with the production rule.
  const initialState = {
    composerHidden: false,
    railWidth: sample.railWidth,
    railFolds: sample.railFolds,
    open: ids.flatMap((id) => sample.payloads[id].cards.map((card) => card.key)),
    read: ids
      .filter((id) => !unread.has(id))
      .flatMap((id) => sample.payloads[id].cards.filter((card) => card.kind === 'turn').map((card) => card.key)),
  };
  const approved = new WeakSet();
  const exportDownloads = new WeakSet();
  const header = document.querySelector('.demo-header');
  const headerSize = () =>
    document.body.style.setProperty('--demo-header-height', `${header.getBoundingClientRect().height}px`);
  new ResizeObserver(headerSize).observe(header);
  headerSize();
  let activityOpened = false;
  let failedRunOpened = false;
  const activityObserver = new MutationObserver(() => {
    if (selected !== 'arc-read-state') return;
    if (!activityOpened) {
      const showAll = document.querySelector('.activitysec .actviewaction');
      if (!showAll) return;
      activityOpened = true;
      showAll.click();
    }
    if (failedRunOpened) return;
    const failedRun = document.querySelector('.activitysec button.actrow.run[data-control$=":run:17"]');
    if (!failedRun) return;
    failedRunOpened = true;
    failedRun.click();
    activityObserver.disconnect();
  });
  activityObserver.observe(document.getElementById('list'), { childList: true, subtree: true });
  const RealDate = Date;
  window.Date = class SampleDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [sample.clock]));
    }
    static now() {
      return sample.clock;
    }
  };

  window.addEventListener(
    'message',
    (event) => {
      if (!approved.has(event)) event.stopImmediatePropagation();
    },
    true,
  );
  function deliver(data) {
    const parsed = sample.host.parseHostToPanel(data);
    if (!parsed) throw new Error(`Invalid demo reply: ${data.type}`);
    const event = new MessageEvent('message', { data: parsed });
    approved.add(event);
    window.dispatchEvent(event);
  }
  function exportSession(session) {
    const filename = sample.exports[session];
    if (!ids.includes(session) || !filename) return;
    const download = document.createElement('a');
    download.href = `./${filename}`;
    download.download = filename;
    exportDownloads.add(download);
    document.body.append(download);
    download.click();
    download.remove();
  }
  function railRows() {
    const original = sample.payloads[selected];
    const rows = original.rail.map((row) => {
      const archived = hidden.has(row.id);
      const pinned = pinnedTop.has(row.id) && !archived;
      const membership = archived ? 'archived' : pinned ? 'pinned' : 'normal';
      const reading = unread.has(row.id) ? 'unread' : 'read';
      const variant = original.railVariants[`${membership}:${reading}`][row.id];
      const { labelClause, ...labelFields } = labelRules.railLabelFields(
        labelRules.labelsOf(labels, row.id),
        sample.labelWords.labelled,
      );
      return {
        ...row,
        ...variant,
        ...labelFields,
        nameAfterAge: [variant.nameAfterAge, labelClause].filter(Boolean).join(', '),
        current: row.id === selected,
        archived,
        pinnedTop: pinned,
      };
    });
    return [
      ...rows.filter((row) => row.pinnedTop),
      ...rows.filter((row) => !row.pinnedTop && !row.archived),
      ...rows.filter((row) => row.archived),
    ];
  }
  function railMessage() {
    const original = sample.payloads[selected];
    deliver({
      type: 'rail',
      queryContext: original.queryContext,
      rail: railRows(),
      labels: labelRules.labelCounts(labels),
      views,
      railFilters,
      stats: original.stats,
      hidden: [...hidden],
      pinnedTop: [...pinnedTop],
      sessionAdoptions: [],
    });
  }
  function render() {
    const original = sample.payloads[selected];
    deliver({
      ...original,
      comments,
      rail: railRows(),
      labels: labelRules.labelCounts(labels),
      views,
      railFilters,
      hidden: [...hidden],
      pinnedTop: [...pinnedTop],
      timelineLayout: layout,
    });
  }
  function labelEditorReply(session) {
    return labelRules.labelEditorReply(labels, sample.payloads[selected].sessions, session, sample.labelWords.heading);
  }
  function visit(session) {
    if (!Object.hasOwn(sample.payloads, session) || session === selected) return;
    trail = placeRules.visitPlace(trail, session);
    selected = session;
    render();
  }
  function navigate(direction) {
    const next = direction === 'goBack' ? placeRules.stepBack(trail) : placeRules.stepForward(trail);
    if (!next) return;
    trail = next;
    selected = placeRules.trailPlace(trail);
    render();
  }
  function membership(action, session) {
    if (!ids.includes(session)) return;
    if (action === 'pin') {
      pinnedTop.add(session);
      hidden.delete(session);
    } else if (action === 'unpin') pinnedTop.delete(session);
    else if (action === 'archive') {
      hidden.add(session);
      pinnedTop.delete(session);
    } else if (action === 'unarchive') hidden.delete(session);
    else return;
    browserState = { ...browserState, hidden: [...hidden], pinnedTop: [...pinnedTop] };
    railMessage();
  }
  function copy(text) {
    if (typeof text === 'string' && text) navigator.clipboard?.writeText(text).catch(() => {});
  }
  // Answer supported context menu actions in page memory. Host actions start nothing.
  sample.installMenu(document, sample.menuEntries, (command, context) => {
    const session = ids.includes(context.session) ? context.session : null;
    const card = Object.values(sample.payloads)
      .flatMap((payload) => payload.cards)
      .find((item) => item.key === context.key);
    switch (command) {
      case 'arc.pinSession':
      case 'arc.unpinSession':
      case 'arc.archiveSession':
      case 'arc.unarchiveSession':
        membership(
          { 'arc.pinSession': 'pin', 'arc.unpinSession': 'unpin', 'arc.archiveSession': 'archive' }[command] ??
            'unarchive',
          session,
        );
        break;
      case 'arc.markSessionRead':
      case 'arc.markSessionUnread':
        if (session) deliver({ type: 'setSessionRead', session, read: command === 'arc.markSessionRead' });
        break;
      case 'arc.markTurnRead':
      case 'arc.markTurnUnread':
        if (card) deliver({ type: 'setRead', key: card.key, read: command === 'arc.markTurnRead' });
        break;
      case 'arc.labelSession':
        if (session) deliver({ type: 'openLabelEditor', session });
        break;
      case 'arc.showSessionDetails':
        if (session) deliver({ type: 'showSessionDetails', session });
        break;
      case 'arc.exportSession':
        exportSession(session);
        break;
      case 'arc.copySessionId':
        copy(session);
        break;
      case 'arc.copyTurnSummary':
        copy(card?.summary);
        break;
      case 'arc.commentOnTurn':
        if (card && card.sessionId === session && session === selected) deliver({ type: 'openComment', key: card.key });
        break;
      case 'arc.renameView':
      case 'arc.deleteView':
        if (views.some((view) => view.id === context.view))
          deliver({
            type: 'openViewEditor',
            view: context.view,
            mode: command === 'arc.renameView' ? 'rename' : 'delete',
          });
        break;
      default:
        break;
    }
  });
  window.acquireVsCodeApi = () => ({
    postMessage(raw) {
      const message = sample.host.parsePanelToHost(raw);
      if (!message || sample.host.policy[message.type] !== 'handled') return;
      switch (message.type) {
        case 'exportSession':
          exportSession(message.session);
          break;
        case 'contextDetail':
          if (ids.includes(message.session))
            deliver(sample.host.contextReply(message, sample.contexts[message.session], sample.clock));
          break;
        case 'pathCompletion':
          deliver({ ...message, rows: [] });
          break;
        case 'importPromptRecovery':
          deliver({ type: 'promptRecovery', submittedPrompts: [] });
          break;
        case 'ready':
          render();
          break;
        case 'showSession':
        case 'showReaderParent':
          visit(message.session);
          break;
        case 'goBack':
        case 'goForward':
          navigate(message.type);
          break;
        case 'refreshUsage':
        case 'newSession':
          break;
        case 'copy':
          copy(message.text);
          break;
        case 'note':
          comments = sample.commentRules.applyComment(comments, message.note);
          deliver({ type: 'notes', comments });
          break;
        case 'setViews':
          if (!Array.isArray(message.views)) break;
          views = message.views;
          railMessage();
          break;
        case 'labelEditor':
          if (ids.includes(message.session)) deliver(labelEditorReply(message.session));
          break;
        case 'setLabels':
          if (!ids.includes(message.session) || !Array.isArray(message.names)) break;
          labels = labelRules.setSessionLabels(
            labels,
            message.session,
            message.names.filter((name) => typeof name === 'string'),
          );
          railMessage();
          deliver(labelEditorReply(message.session));
          deliver({ type: 'labelsChanged', session: message.session });
          break;
        case 'setRailFilters':
          if (!Array.isArray(message.railFilters)) break;
          railFilters = message.railFilters;
          railMessage();
          break;
        case 'sessionMembership':
          membership(message.action, message.session);
          break;
        case 'setLayout':
          if (message.key === 'cardLayout' && ['compact', 'one-column', 'two-columns'].includes(message.value))
            layout = { ...layout, cardLayout: message.value };
          else if (message.key === 'promptPosition' && ['above', 'below'].includes(message.value))
            layout = { ...layout, promptPosition: message.value };
          else break;
          deliver({ type: 'layout', layout });
          break;
        case 'saveState':
          browserState = message.state;
          if (browserState && typeof browserState === 'object') {
            const read = Array.isArray(browserState.read) ? browserState.read : [];
            const readTo = new Map(
              Object.entries(browserState.readTo ?? {}).filter(([, at]) => typeof at === 'number'),
            );
            const since = typeof browserState.since === 'number' ? browserState.since : 0;
            let changed = false;
            for (const id of ids) {
              const isUnread =
                (readRules.newBySession(sample.payloads[id].cards, read, readTo, since).get(id) ?? 0) > 0;
              if (isUnread === unread.has(id)) continue;
              if (isUnread) unread.add(id);
              else unread.delete(id);
              changed = true;
            }
            if (changed) railMessage();
          }
          break;
        case 'painted':
        case 'perf':
        case 'armSessionDetails':
        case 'armSelectedText':
        case 'armComposer':
          break;
      }
    },
    getState() {
      return browserState ?? initialState;
    },
    setState(state) {
      browserState = state;
    },
  });

  for (const kind of ['paste', 'drop', 'dragenter', 'dragover', 'change', 'submit']) {
    document.addEventListener(
      kind,
      (event) => {
        if (kind === 'paste' && !event.clipboardData?.files.length) return;
        if (
          ['drop', 'dragenter', 'dragover'].includes(kind) &&
          !Array.from(event.dataTransfer?.types ?? []).includes('Files')
        )
          return;
        if (kind === 'change' && !(event.target instanceof HTMLInputElement && event.target.type === 'file')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      true,
    );
  }
  document.addEventListener(
    'keydown',
    (event) => {
      const target = event.target;
      const prompt = target instanceof HTMLTextAreaElement && target.id === 'prompt';
      const editable = target instanceof Element && target.closest('input,textarea,[contenteditable]');
      const chord = sample.isSendChord(event, navigator.platform);
      const composing = event.isComposing || event.keyCode === 229;
      if (!editable) {
        const direction = sample.navigationShortcut(event, navigator.platform);
        if (direction) {
          event.preventDefault();
          event.stopImmediatePropagation();
          navigate(direction);
          return;
        }
      }
      const enter =
        prompt &&
        event.key === 'Enter' &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        (composing || target.getAttribute('aria-expanded') !== 'true');
      if ((chord && (prompt || !editable)) || enter) {
        if (!composing) event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
    },
    true,
  );
  document.addEventListener(
    'click',
    (event) => {
      if (!(event.target instanceof Element)) return;
      if (exportDownloads.has(event.target.closest('a'))) return;
      const link = event.target.closest('#list .summary a[data-link]');
      const target = link && sample.parseSessionLink(link.dataset.link || '');
      if (target?.kind === 'session' && ids.includes(target.session)) return;
      if (event.target.closest('#composer .csend')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      const label = event.target.closest('label');
      if (
        !event.target.closest('a,input[type="file"]') &&
        !(label?.control instanceof HTMLInputElement && label.control.type === 'file')
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );
  document.getElementById('demo-theme').addEventListener('change', (event) => {
    const name = event.target.value;
    if (!['onedark', 'dark', 'light'].includes(name)) return;
    document.documentElement.dataset.theme = name;
    document.body.dataset.theme = name;
    document.body.className = name === 'light' ? 'vscode-light' : 'vscode-dark';
  });
})();
