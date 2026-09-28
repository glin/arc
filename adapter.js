(()=>{function B(t,s,n){if(t.length<=s)return t;let e=t.slice(0,Math.max(0,s-n.length)),o=e.charCodeAt(e.length-1);return o>=55296&&o<=56319&&(e=e.slice(0,-1)),e+n}var H=/[\p{Cc}\p{Cf}\p{Cs}]/gu,W=/[\u200c\u200d\u{e0020}-\u{e007f}]/u,j=/\u200d+$/u,F=/[^\p{White_Space}\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]/u;function I(t,s){if(typeof t!="string")return"";let o=t.normalize("NFC").replace(/\p{White_Space}+/gu," ").replace(H,r=>W.test(r)?r:"").normalize("NFC").trim(),i=B(o,s,"").replace(j,"").trim();return F.test(i)?i:""}function h(t){return t.toLocaleLowerCase()}function L(t){return t===1?"carried by one session":`carried by ${t} sessions`}var z=20,X=500,U=2;function w(t){return I(t,40)}function v(t,s){let n=[],e=new Set;for(let o of t){let i=w(o);if(!i)continue;let r=h(i),l=s.get(r);if(l===void 0&&s.set(r,i),!e.has(r)&&(e.add(r),n.push(l??i),n.length===z))break}return n}function M(t,s){let n=Object.prototype.hasOwnProperty.call(t,s)?t[s]:null;return Array.isArray(n)?[...n]:[]}function T(t,s,n){let e=!!s&&s!=="__proto__"&&v(n,new Map).length>0,o=[];for(let[c,g]of Object.entries(t))c!==s&&c!=="__proto__"&&o.push([c,g]);let i=X-(e?1:0),r=new Map,l={};for(let[c,g]of o.slice(Math.max(0,o.length-Math.max(0,i)))){l[c]=[...g];for(let u of g){let p=h(u);r.has(p)||r.set(p,u)}}return e&&(l[s]=v(n,r)),l}function K(t){let s=t.slice(0,U),n=t.slice(s.length);return{chips:s,more:n.length?`+${n.length}`:null,rest:n}}function k(t,s){let{chips:n,more:e,rest:o}=K(t);return{labels:[...t],labelChips:n,labelsMore:e,labelsMoreName:o.length?o.join(", "):null,labelClause:t.length?`${s} ${t.join(", ")}`:null}}function S(t){let s=new Map;for(let[n,e]of Object.entries(t)){if(!n||n==="__proto__"||!Array.isArray(e))continue;let o=new Set;for(let i of e){let r=w(i);if(!r)continue;let l=h(r);if(o.has(l))continue;o.add(l);let c=s.get(l);c?c.count+=1:s.set(l,{name:r,count:1})}}return[...s.values()].sort((n,e)=>e.count-n.count||n.name.localeCompare(e.name)).map(n=>({...n,countName:L(n.count)}))}function V(t,s){let n=S(t),e=new Map(n.map(r=>[h(r.name),r])),o=new Set,i=[];for(let r of M(t,s)){let l=w(r);if(!l)continue;let c=h(l),g=e.get(c);!g||o.has(c)||(o.add(c),i.push({...g,applied:!0}))}for(let r of n)o.has(h(r.name))||i.push({...r,applied:!1});return i}function D(t,s,n,e,o=n){let i=s.find(r=>r.id===n)?.label??n;return{type:"labelEditor",session:o,heading:`${e} ${i}`,rows:V(t,n)}}function Y(t,s){if(!t.trim())return!0;let n=a=>{throw new Error(`The menu stand-in cannot read the when clause "${t}": ${a}.`)},e=[],o=/\s*('[^']*'|==|!=|&&|\|\||[!()]|[A-Za-z_][\w.:-]*)/y;for(;o.lastIndex<t.length&&t.slice(o.lastIndex).trim();){let a=o.lastIndex,f=o.exec(t);f||n(`unsupported text at "${t.slice(a).trim()}"`),e.push(f[1])}let i=a=>a!==void 0&&/^[A-Za-z_]/.test(a),r=0,l=a=>a?.startsWith("'")?a.slice(1,-1):(i(a)||n(`a comparison has no value after "${e[r-2]} ${e[r-1]}"`),a==="true"?!0:a==="false"?!1:a),c=()=>{let a=e[r++];if(a==="("){let b=u();return e[r++]!==")"&&n("a parenthesis is not closed"),b}if(a==="!")return!c();i(a)||n(a===void 0?"it ends early":`unexpected "${a}"`);let f=s[a];if(e[r]==="=="||e[r]==="!="){let b=e[r++]==="==",y=l(e[r++]);return(f===y||String(f)===String(y))===b}return!!f},g=()=>{let a=c();for(;e[r]==="&&";)r++,a=c()&&a;return a},u=()=>{let a=g();for(;e[r]==="||";)r++,a=g()||a;return a},p=u();return r<e.length&&n(`unexpected "${e[r]}"`),p}function q(t,s){let n=new Map;for(let e of t){if(!Y(e.when,s))continue;let[o,i]=e.group.split("@"),r=n.get(o)??[];r.push({order:Number(i)||0,entry:e}),n.set(o,r)}return[...n.keys()].sort((e,o)=>e==="navigation"?-1:o==="navigation"?1:e<o?-1:e>o?1:0).map(e=>n.get(e).sort((o,i)=>o.order-i.order).map(o=>o.entry))}function G(t){let s=[];for(let n=t;n;n=n.parentElement){let e=n.dataset?.vscodeContext;if(e)try{s.push(JSON.parse(e))}catch{}}return Object.assign({},...s.reverse())}function $(t,s,n){let e=t.defaultView,o=null;e.addEventListener("contextmenu",i=>{let r=i.target instanceof Element?i.target:null;if(!r||r.closest(".demo-menu"))return;o?.(!1);let l=G(r),c=q(s,l);if(!c.length)return;i.preventDefault();let g=t.activeElement instanceof HTMLElement?t.activeElement:null,u=t.createElement("div");u.className="demo-menu",u.setAttribute("role","menu"),c.forEach((d,E)=>{if(E){let m=t.createElement("div");m.setAttribute("role","separator"),u.append(m)}for(let m of d){let _=t.createElement("button");_.type="button",_.setAttribute("role","menuitem"),_.tabIndex=-1,_.textContent=m.title,_.addEventListener("click",()=>{o?.(!0),n(m.command,l)}),u.append(_)}}),t.body.append(u);let p=Array.from(u.querySelectorAll('[role="menuitem"]')),a=r.getBoundingClientRect(),f=i.clientX===0&&i.clientY===0,b=f?a.left:i.clientX,y=f?a.bottom:i.clientY,A=u.offsetWidth,R=u.offsetHeight;u.style.left=`${Math.max(0,b+A>e.innerWidth?e.innerWidth-A:b)}px`,u.style.top=`${Math.max(0,y+R>e.innerHeight?y-R:y)}px`;let C=d=>{(!(d.target instanceof Node)||!u.contains(d.target))&&o?.(!1)},x=d=>{u.remove(),t.removeEventListener("pointerdown",C,!0),e.removeEventListener("blur",N),o=null,d&&g?.isConnected&&g.focus()},N=()=>x(!1);o=x,t.addEventListener("pointerdown",C,!0),e.addEventListener("blur",N),u.addEventListener("keydown",d=>{let E=p.indexOf(t.activeElement),m=d.key==="ArrowDown"?(E+1)%p.length:d.key==="ArrowUp"?(E-1+p.length)%p.length:d.key==="Home"?0:d.key==="End"?p.length-1:-1;m>=0?(d.preventDefault(),p[m].focus()):(d.key==="Escape"||d.key==="Tab")&&(d.preventDefault(),x(!0))}),p[0].focus()})}window.__ARC_DEMO_SAMPLES__.labelRules={labelCounts:S,labelEditorReply:D,labelsOf:M,railLabelFields:k,setSessionLabels:T};window.__ARC_DEMO_SAMPLES__.installMenu=$;})();
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
        if (!session) break;
        if (command === 'arc.markSessionUnread') unread.add(session);
        deliver({ type: 'setSessionRead', session, read: command === 'arc.markSessionRead' });
        if (command === 'arc.markSessionUnread') railMessage();
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
        case 'armSessionDetails':
        case 'armSelectedText':
        case 'armComposer':
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
