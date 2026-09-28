(()=>{function A(t,e,n){if(t.length<=e)return t;let o=t.slice(0,Math.max(0,e-n.length)),s=o.charCodeAt(o.length-1);return s>=55296&&s<=56319&&(o=o.slice(0,-1)),o+n}var S=/[\p{Cc}\p{Cf}\p{Cs}]/gu,N=/[\u200c\u200d\u{e0020}-\u{e007f}]/u,x=/\u200d+$/u,M=/[^\p{White_Space}\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]/u;function y(t,e){if(typeof t!="string")return"";let s=t.normalize("NFC").replace(/\p{White_Space}+/gu," ").replace(S,r=>N.test(r)?r:"").normalize("NFC").trim(),i=A(s,e,"").replace(x,"").trim();return M.test(i)?i:""}function c(t){return t.toLocaleLowerCase()}function u(t){return t===1?"carried by one session":`carried by ${t} sessions`}var C=20,I=500,O=2;function p(t){return y(t,40)}function m(t,e){let n=[],o=new Set;for(let s of t){let i=p(s);if(!i)continue;let r=c(i),a=e.get(r);if(a===void 0&&e.set(r,i),!o.has(r)&&(o.add(r),n.push(a??i),n.length===C))break}return n}function d(t,e){let n=Object.prototype.hasOwnProperty.call(t,e)?t[e]:null;return Array.isArray(n)?[...n]:[]}function L(t,e,n){let o=!!e&&e!=="__proto__"&&m(n,new Map).length>0,s=[];for(let[l,g]of Object.entries(t))l!==e&&l!=="__proto__"&&s.push([l,g]);let i=I-(o?1:0),r=new Map,a={};for(let[l,g]of s.slice(Math.max(0,s.length-Math.max(0,i)))){a[l]=[...g];for(let _ of g){let b=c(_);r.has(b)||r.set(b,_)}}return o&&(a[e]=m(n,r)),a}function T(t){let e=t.slice(0,O),n=t.slice(e.length);return{chips:e,more:n.length?`+${n.length}`:null,rest:n}}function E(t,e){let{chips:n,more:o,rest:s}=T(t);return{labels:[...t],labelChips:n,labelsMore:o,labelsMoreName:s.length?s.join(", "):null,labelClause:t.length?`${e} ${t.join(", ")}`:null}}function f(t){let e=new Map;for(let[n,o]of Object.entries(t)){if(!n||n==="__proto__"||!Array.isArray(o))continue;let s=new Set;for(let i of o){let r=p(i);if(!r)continue;let a=c(r);if(s.has(a))continue;s.add(a);let l=e.get(a);l?l.count+=1:e.set(a,{name:r,count:1})}}return[...e.values()].sort((n,o)=>o.count-n.count||n.name.localeCompare(o.name)).map(n=>({...n,countName:u(n.count)}))}function k(t,e){let n=f(t),o=new Map(n.map(r=>[c(r.name),r])),s=new Set,i=[];for(let r of d(t,e)){let a=p(r);if(!a)continue;let l=c(a),g=o.get(l);!g||s.has(l)||(s.add(l),i.push({...g,applied:!0}))}for(let r of n)s.has(c(r.name))||i.push({...r,applied:!1});return i}function R(t,e,n,o,s=n){let i=e.find(r=>r.id===n)?.label??n;return{type:"labelEditor",session:s,heading:`${o} ${i}`,rows:k(t,n)}}window.__ARC_DEMO_SAMPLES__.labelRules={labelCounts:f,labelEditorReply:R,labelsOf:d,railLabelFields:E,setSessionLabels:L};})();
(() => {
  'use strict';
  const sample = window.__ARC_DEMO_SAMPLES__;
  const ids = Object.keys(sample.payloads);
  let selected = ids[0];
  let layout = { cardLayout: 'two-columns', promptPosition: 'above' };
  let views = sample.payloads[selected].views;
  let railFilters = sample.payloads[selected].railFilters;
  const pinnedTop = new Set(sample.payloads[selected].pinnedTop);
  const hidden = new Set(sample.payloads[selected].hidden);
  const unread = new Set(sample.payloads[selected].rail.filter((row) => row.unread).map((row) => row.id));
  const labelRules = sample.labelRules;
  let labels = sample.labels;
  let browserState = null;
  const approved = new WeakSet();
  const header = document.querySelector('.demo-header');
  const notice = document.getElementById('demo-notice');
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
    const event = new MessageEvent('message', { data });
    approved.add(event);
    window.dispatchEvent(event);
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
  function readOnlyNotice() {
    notice.replaceChildren(document.createTextNode('Open Arc in VS Code to start a conversation.'));
  }
  const allowed = new Set([
    'ready',
    'painted',
    'perf',
    'showSession',
    'setLayout',
    'saveState',
    'setViews',
    'setRailFilters',
    'sessionMembership',
    'newSession',
    'labelEditor',
    'setLabels',
  ]);
  window.acquireVsCodeApi = () => ({
    postMessage(message) {
      if (!message || typeof message.type !== 'string' || !allowed.has(message.type)) {
        console.warn('Arc sample ignored a panel action');
        return;
      }
      switch (message.type) {
        case 'ready':
          render();
          break;
        case 'showSession':
          if (Object.hasOwn(sample.payloads, message.session)) {
            selected = message.session;
            render();
          }
          break;
        case 'newSession':
          readOnlyNotice();
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
          if (message.action === 'unarchiveAll') {
            hidden.clear();
            browserState = { ...browserState, hidden: [], pinnedTop: [...pinnedTop] };
            railMessage();
            break;
          }
          if (!ids.includes(message.session)) break;
          if (message.action === 'pin') {
            pinnedTop.add(message.session);
            hidden.delete(message.session);
          } else if (message.action === 'unpin') pinnedTop.delete(message.session);
          else if (message.action === 'archive') {
            hidden.add(message.session);
            pinnedTop.delete(message.session);
          } else if (message.action === 'unarchive') hidden.delete(message.session);
          else break;
          browserState = { ...browserState, hidden: [...hidden], pinnedTop: [...pinnedTop] };
          railMessage();
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
            let changed = false;
            for (const id of unread) {
              const turn = sample.payloads[id].cards.find((card) => card.kind === 'turn');
              if (
                turn &&
                (browserState.read?.includes(turn.key) ||
                  (typeof browserState.readTo?.[id] === 'number' && browserState.readTo[id] >= turn.startedAt))
              ) {
                unread.delete(id);
                changed = true;
              }
            }
            if (changed) railMessage();
          }
          break;
        case 'painted':
        case 'perf':
          break;
      }
    },
    getState() {
      return browserState ?? { composerHidden: true, railWidth: 300, open: [sample.payloads[selected].cards[0].key] };
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
      if (
        event.key !== 'c' ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        (event.target instanceof Element && event.target.closest('input,textarea,[contenteditable]'))
      )
        return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.anchorNode?.parentElement?.closest('.turn')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );
  document.addEventListener(
    'click',
    (event) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest('.quoteact,.noteact,.notesave')) {
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
