(()=>{function H(e,s,n){if(e.length<=s)return e;let t=e.slice(0,Math.max(0,s-n.length)),o=t.charCodeAt(t.length-1);return o>=55296&&o<=56319&&(t=t.slice(0,-1)),t+n}var P=/[\p{Cc}\p{Cf}\p{Cs}]/gu,j=/[\u200c\u200d\u{e0020}-\u{e007f}]/u,F=/\u200d+$/u,z=/[^\p{White_Space}\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]/u;function N(e,s){if(typeof e!="string")return"";let o=e.normalize("NFC").replace(/\p{White_Space}+/gu," ").replace(P,r=>j.test(r)?r:"").normalize("NFC").trim(),i=H(o,s,"").replace(F,"").trim();return z.test(i)?i:""}function b(e){return e.toLocaleLowerCase()}function L(e){return e===1?"carried by one session":`carried by ${e} sessions`}var K=20,U=500,J=2;function M(e){return N(e,40)}function O(e,s){let n=[],t=new Set;for(let o of e){let i=M(o);if(!i)continue;let r=b(i),a=s.get(r);if(a===void 0&&s.set(r,i),!t.has(r)&&(t.add(r),n.push(a??i),n.length===K))break}return n}function w(e,s){let n=Object.prototype.hasOwnProperty.call(e,s)?e[s]:null;return Array.isArray(n)?[...n]:[]}function v(e,s,n){let t=!!s&&s!=="__proto__"&&O(n,new Map).length>0,o=[];for(let[c,g]of Object.entries(e))c!==s&&c!=="__proto__"&&o.push([c,g]);let i=U-(t?1:0),r=new Map,a={};for(let[c,g]of o.slice(Math.max(0,o.length-Math.max(0,i)))){a[c]=[...g];for(let u of g){let f=b(u);r.has(f)||r.set(f,u)}}return t&&(a[s]=O(n,r)),a}function V(e){let s=e.slice(0,J),n=e.slice(s.length);return{chips:s,more:n.length?`+${n.length}`:null,rest:n}}function k(e,s){let{chips:n,more:t,rest:o}=V(e);return{labels:[...e],labelChips:n,labelsMore:t,labelsMoreName:o.length?o.join(", "):null,labelClause:e.length?`${s} ${e.join(", ")}`:null}}function S(e){let s=new Map;for(let[n,t]of Object.entries(e)){if(!n||n==="__proto__"||!Array.isArray(t))continue;let o=new Set;for(let i of t){let r=M(i);if(!r)continue;let a=b(r);if(o.has(a))continue;o.add(a);let c=s.get(a);c?c.count+=1:s.set(a,{name:r,count:1})}}return[...s.values()].sort((n,t)=>t.count-n.count||n.name.localeCompare(t.name)).map(n=>({...n,countName:L(n.count)}))}function Y(e,s){let n=S(e),t=new Map(n.map(r=>[b(r.name),r])),o=new Set,i=[];for(let r of w(e,s)){let a=M(r);if(!a)continue;let c=b(a),g=t.get(c);!g||o.has(c)||(o.add(c),i.push({...g,applied:!0}))}for(let r of n)o.has(b(r.name))||i.push({...r,applied:!1});return i}function D(e,s,n,t,o=n){let i=s.find(r=>r.id===n)?.label??n;return{type:"labelEditor",session:o,heading:`${t} ${i}`,rows:Y(e,n)}}function $(e,s,n,t=0){if(s.has(e.key))return!0;let o=n.get(e.sessionId)??t;return o>0&&e.startedAt<=o}function B(e,s,n,t=0){let o=new Set(s),i=new Map;for(let a of e){if(a.kind!=="turn"||!$(a,o,n,t))continue;let c=i.get(a.sessionId);(c===void 0||a.startedAt>c)&&i.set(a.sessionId,a.startedAt)}let r=new Map;for(let a of e){if(a.kind!=="turn"||(r.has(a.sessionId)||r.set(a.sessionId,0),$(a,o,n,t)))continue;let c=i.get(a.sessionId);c!==void 0&&a.startedAt<=c||r.set(a.sessionId,r.get(a.sessionId)+1)}return r}function q(e,s){if(!e.trim())return!0;let n=l=>{throw new Error(`The menu stand-in cannot read the when clause "${e}": ${l}.`)},t=[],o=/\s*('[^']*'|==|!=|&&|\|\||[!()]|[A-Za-z_][\w.:-]*)/y;for(;o.lastIndex<e.length&&e.slice(o.lastIndex).trim();){let l=o.lastIndex,p=o.exec(e);p||n(`unsupported text at "${e.slice(l).trim()}"`),t.push(p[1])}let i=l=>l!==void 0&&/^[A-Za-z_]/.test(l),r=0,a=l=>l?.startsWith("'")?l.slice(1,-1):(i(l)||n(`a comparison has no value after "${t[r-2]} ${t[r-1]}"`),l==="true"?!0:l==="false"?!1:l),c=()=>{let l=t[r++];if(l==="("){let h=u();return t[r++]!==")"&&n("a parenthesis is not closed"),h}if(l==="!")return!c();i(l)||n(l===void 0?"it ends early":`unexpected "${l}"`);let p=s[l];if(t[r]==="=="||t[r]==="!="){let h=t[r++]==="==",y=a(t[r++]);return(p===y||String(p)===String(y))===h}return!!p},g=()=>{let l=c();for(;t[r]==="&&";)r++,l=c()&&l;return l},u=()=>{let l=g();for(;t[r]==="||";)r++,l=g()||l;return l},f=u();return r<t.length&&n(`unexpected "${t[r]}"`),f}function G(e,s){let n=new Map;for(let t of e){if(!q(t.when,s))continue;let[o,i]=t.group.split("@"),r=n.get(o)??[];r.push({order:Number(i)||0,entry:t}),n.set(o,r)}return[...n.keys()].sort((t,o)=>t==="navigation"?-1:o==="navigation"?1:t<o?-1:t>o?1:0).map(t=>n.get(t).sort((o,i)=>o.order-i.order).map(o=>o.entry))}function Z(e){let s=[];for(let n=e;n;n=n.parentElement){let t=n.dataset?.vscodeContext;if(t)try{s.push(JSON.parse(t))}catch{}}return Object.assign({},...s.reverse())}function W(e,s,n){let t=e.defaultView,o=null;t.addEventListener("contextmenu",i=>{let r=i.target instanceof Element?i.target:null;if(!r||r.closest(".demo-menu"))return;o?.(!1);let a=Z(r),c=G(s,a);if(!c.length)return;i.preventDefault();let g=e.activeElement instanceof HTMLElement?e.activeElement:null,u=e.createElement("div");u.className="demo-menu",u.setAttribute("role","menu"),c.forEach((d,x)=>{if(x){let m=e.createElement("div");m.setAttribute("role","separator"),u.append(m)}for(let m of d){let _=e.createElement("button");_.type="button",_.setAttribute("role","menuitem"),_.tabIndex=-1,_.textContent=m.title,_.addEventListener("click",()=>{o?.(!0),n(m.command,a)}),u.append(_)}}),e.body.append(u);let f=Array.from(u.querySelectorAll('[role="menuitem"]')),l=r.getBoundingClientRect(),p=i.clientX===0&&i.clientY===0,h=p?l.left:i.clientX,y=p?l.bottom:i.clientY,R=u.offsetWidth,A=u.offsetHeight;u.style.left=`${Math.max(0,h+R>t.innerWidth?t.innerWidth-R:h)}px`,u.style.top=`${Math.max(0,y+A>t.innerHeight?y-A:y)}px`;let I=d=>{(!(d.target instanceof Node)||!u.contains(d.target))&&o?.(!1)},E=d=>{u.remove(),e.removeEventListener("pointerdown",I,!0),t.removeEventListener("blur",C),o=null,d&&g?.isConnected&&g.focus()},C=()=>E(!1);o=E,e.addEventListener("pointerdown",I,!0),t.addEventListener("blur",C),u.addEventListener("keydown",d=>{let x=f.indexOf(e.activeElement),m=d.key==="ArrowDown"?(x+1)%f.length:d.key==="ArrowUp"?(x-1+f.length)%f.length:d.key==="Home"?0:d.key==="End"?f.length-1:-1;m>=0?(d.preventDefault(),f[m].focus()):(d.key==="Escape"||d.key==="Tab")&&(d.preventDefault(),E(!0))}),f[0].focus()})}window.__ARC_DEMO_SAMPLES__.labelRules={labelCounts:S,labelEditorReply:D,labelsOf:w,railLabelFields:k,setSessionLabels:v};window.__ARC_DEMO_SAMPLES__.readRules={newBySession:B};window.__ARC_DEMO_SAMPLES__.installMenu=W;})();
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
  const readRules = sample.readRules;
  let labels = sample.labels;
  let browserState = null;
  // A session the demo lists as read starts with its turns marked read, so the panel's read
  // marks and the session list agree. Each save then decides a session's unread state from
  // those marks with the extension's rule.
  const initialState = {
    composerHidden: true,
    railWidth: 300,
    open: [sample.payloads[selected].cards[0].key],
    read: ids
      .filter((id) => !unread.has(id))
      .flatMap((id) => sample.payloads[id].cards.filter((card) => card.kind === 'turn').map((card) => card.key)),
  };
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
  // The context menu's entries, answered the way the extension answers them, in page memory.
  // New session with the same labels and the Send entries start nothing and show the notice.
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
      case 'arc.copySessionId':
        copy(session);
        break;
      case 'arc.copyTurnSummary':
        copy(card?.summary);
        break;
      default:
        readOnlyNotice();
    }
  });
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
    'armSessionDetails',
    'armSelectedText',
    'armComposer',
    'copy',
  ]);
  window.acquireVsCodeApi = () => ({
    postMessage(message) {
      if (!message || typeof message.type !== 'string' || !allowed.has(message.type)) {
        console.warn('Arc demo ignored a panel action');
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
        case 'copy':
          copy(message.text);
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
