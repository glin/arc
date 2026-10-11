(()=>{function _(t,e,o){if(t.length<=e)return t;let s=t.slice(0,Math.max(0,e-o.length)),n=s.charCodeAt(s.length-1);return n>=55296&&n<=56319&&(s=s.slice(0,-1)),s+o}var qe=/[\p{Cc}\p{Cf}\p{Cs}]/gu,Ue=/[\u200c\u200d\u{e0020}-\u{e007f}]/u,je=/\u200d+$/u,We=/[^\p{White_Space}\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]/u;function N(t,e){if(typeof t!="string")return"";let n=t.normalize("NFC").replace(/\p{White_Space}+/gu," ").replace(qe,i=>Ue.test(i)?i:"").normalize("NFC").trim(),a=_(n,e,"").replace(je,"").trim();return We.test(a)?a:""}function w(t){return t.toLocaleLowerCase()}function F(t){return t===1?"carried by one session":`carried by ${t} sessions`}var Be=20,Ke=500,Qe=2;function H(t){return N(t,40)}function te(t,e){let o=[],s=new Set;for(let n of t){let a=H(n);if(!a)continue;let i=w(a),l=e.get(i);if(l===void 0&&e.set(i,a),!s.has(i)&&(s.add(i),o.push(l??a),o.length===Be))break}return o}function $(t,e){let o=Object.prototype.hasOwnProperty.call(t,e)?t[e]:null;return Array.isArray(o)?[...o]:[]}function oe(t,e,o){let s=!!e&&e!=="__proto__"&&te(o,new Map).length>0,n=[];for(let[c,f]of Object.entries(t))c!==e&&c!=="__proto__"&&n.push([c,f]);let a=Ke-(s?1:0),i=new Map,l={};for(let[c,f]of n.slice(Math.max(0,n.length-Math.max(0,a)))){l[c]=[...f];for(let d of f){let p=w(d);i.has(p)||i.set(p,d)}}return s&&(l[e]=te(o,i)),l}function ze(t){let e=t.slice(0,Qe),o=t.slice(e.length);return{chips:e,more:o.length?`+${o.length}`:null,rest:o}}function se(t,e){let{chips:o,more:s,rest:n}=ze(t);return{labels:[...t],labelChips:o,labelsMore:s,labelsMoreName:n.length?n.join(", "):null,labelClause:t.length?`${e} ${t.join(", ")}`:null}}function V(t){let e=new Map;for(let[o,s]of Object.entries(t)){if(!o||o==="__proto__"||!Array.isArray(s))continue;let n=new Set;for(let a of s){let i=H(a);if(!i)continue;let l=w(i);if(n.has(l))continue;n.add(l);let c=e.get(l);c?c.count+=1:e.set(l,{name:i,count:1})}}return[...e.values()].sort((o,s)=>s.count-o.count||o.name.localeCompare(s.name)).map(o=>({...o,countName:F(o.count)}))}function Ye(t,e){let o=V(t),s=new Map(o.map(i=>[w(i.name),i])),n=new Set,a=[];for(let i of $(t,e)){let l=H(i);if(!l)continue;let c=w(l),f=s.get(c);!f||n.has(c)||(n.add(c),a.push({...f,applied:!0}))}for(let i of o)n.has(w(i.name))||a.push({...i,applied:!1});return a}function ie(t,e,o,s,n=o){let a=e.find(i=>i.id===o)?.label??o;return{type:"labelEditor",session:n,heading:`${s} ${a}`,rows:Ye(t,o)}}function ae(t,e,o,s=0){if(e.has(t.key))return!0;let n=o.get(t.sessionId)??s;return n>0&&t.startedAt<=n}function le(t,e,o,s=0){let n=new Set(e),a=new Map;for(let l of t){if(l.kind!=="turn"||!ae(l,n,o,s))continue;let c=a.get(l.sessionId);(c===void 0||l.startedAt>c)&&a.set(l.sessionId,l.startedAt)}let i=new Map;for(let l of t){if(l.kind!=="turn"||(i.has(l.sessionId)||i.set(l.sessionId,0),ae(l,n,o,s)))continue;let c=a.get(l.sessionId);c!==void 0&&l.startedAt<=c||i.set(l.sessionId,i.get(l.sessionId)+1)}return i}var q="…";function ue(t){return!!t&&/^\S{1,200}$/.test(t)}var Je=200,ce=6e3,C=2e3,Ze=/^answer:\d{1,4}$/,et=/^prompt:\d{1,4}$/;function tt(t){return t==="prompt"||t==="summary"||typeof t=="string"&&Ze.test(t)||typeof t=="string"&&et.test(t)||typeof t=="string"&&t.startsWith("said:")&&ue(t.slice(5))?t:"summary"}function nt(t){if(!t||typeof t!="object"||Array.isArray(t))return null;let e=t,o=(d,p)=>typeof d=="string"?_(d,p,q):"",s=d=>typeof d=="number"&&Number.isFinite(d)?d:null,n=o(e.id,C),a=o(e.sessionId,C),i=o(e.turnKey,C),l=o(e.note,ce).trim(),c=s(e.at),f=s(e.turnAt);return!n||!a||!i||!l||c===null||f===null?null:{id:n,sessionId:a,turnKey:i,part:tt(e.part),quote:o(e.quote,ce),offset:typeof e.offset=="number"&&Number.isFinite(e.offset)&&e.offset>=0?Math.trunc(e.offset):void 0,note:l,headline:o(e.headline,C),sessionTitle:o(e.sessionTitle,C),turnAt:f,at:c}}function E(t){let e=[];if(Array.isArray(t))for(let o of t){let s=nt(o);s&&e.push(s)}return e.slice(Math.max(0,e.length-Je))}function de(t,e){if(!e||typeof e!="object")return[...t];let o=e;if(o.op==="clear"){let i=typeof o.sessionId=="string"?o.sessionId:"";return i?E(t.filter(l=>l.sessionId!==i)):[...t]}if(o.op==="delete"){let i=typeof o.id=="string"?o.id:"";return i?E(t.filter(l=>l.id!==i)):[...t]}if(o.op!=="write")return[...t];let[s]=E([o.note]);if(!s)return[...t];let n=t.findIndex(i=>i.id===s.id),a=[...t];return n<0?a.push(s):a[n]=s,E(a)}function pe(){return{places:[],at:-1}}function U(t){return t.at>=0&&t.at<t.places.length?t.places[t.at]:null}function rt(t){return t.at>0}function ot(t){return t.at>=0&&t.at<t.places.length-1}function fe(t,e){if(!e||U(t)===e)return t;let o=t.places.slice(0,t.at+1);return o.push(e),st({places:o,at:o.length-1})}function me(t){return rt(t)?{places:t.places,at:t.at-1}:null}function ge(t){return ot(t)?{places:t.places,at:t.at+1}:null}function st(t){if(t.places.length<=50)return t;let e=t.places.length-50;return{places:t.places.slice(e),at:t.at-e}}function it(t){return/^Mac/.test(t||"")}function ye(t,e){return!t||t.key!=="Enter"||t.altKey||t.shiftKey?!1:it(e)?!!t.metaKey&&!t.ctrlKey:!!t.ctrlKey&&!t.metaKey}var at="`",_n=at.repeat(3);function he(t,e){if(t.defaultPrevented||t.isComposing||t.keyCode===229||t.metaKey)return null;if(/^Win/.test(e))return!t.altKey||t.ctrlKey||t.shiftKey?null:t.key==="ArrowLeft"?"goBack":t.key==="ArrowRight"?"goForward":null;if((t.key==="-"||t.code==="Minus")&&t.ctrlKey){if(t.shiftKey&&!t.altKey)return"goForward";if(!t.shiftKey&&t.altKey===!/^Mac/.test(e))return"goBack"}return null}var be={productName:"Arc",repositoryName:"arc",publisher:"glin",extensionName:"arc",extensionId:"glin.arc",commandPrefix:"arc",settingsSection:"arc",panelType:"arc.panel",panelStateKey:"arc.panelState",homeDirectory:".arc",snapshotsDirectory:"snapshots",environmentPrefix:"ARC_",visualizationScheme:"arc-visualization:",sessionScheme:"arc-session:",cliPackageName:"@glin/arc",cliExecutable:"arc-status",vsixFileName:"arc.vsix",baselineScheme:"arc-baseline",patchScheme:"arc-patch"};function lt(t){return t.length>0&&!/[\s\u0000-\u001f\u007f-\u009f\\/?#]/u.test(t)}function we(t){let e=t.trimStart(),o=be.sessionScheme;if(e.slice(0,o.length).toLowerCase()!==o)return{kind:"other"};try{let s=decodeURIComponent(e.slice(o.length));return lt(s)?{kind:"session",session:s}:{kind:"invalid"}}catch{return{kind:"invalid"}}}function ut(t,e){if(!t.trim())return!0;let o=u=>{throw new Error(`The menu stand-in cannot read the when clause "${t}": ${u}.`)},s=[],n=/\s*('[^']*'|==|!=|&&|\|\||[!()]|[A-Za-z_][\w.:-]*)/y;for(;n.lastIndex<t.length&&t.slice(n.lastIndex).trim();){let u=n.lastIndex,b=n.exec(t);b||o(`unsupported text at "${t.slice(u).trim()}"`),s.push(b[1])}let a=u=>u!==void 0&&/^[A-Za-z_]/.test(u),i=0,l=u=>u?.startsWith("'")?u.slice(1,-1):(a(u)||o(`a comparison has no value after "${s[i-2]} ${s[i-1]}"`),u==="true"?!0:u==="false"?!1:u),c=()=>{let u=s[i++];if(u==="("){let k=d();return s[i++]!==")"&&o("a parenthesis is not closed"),k}if(u==="!")return!c();a(u)||o(u===void 0?"it ends early":`unexpected "${u}"`);let b=e[u];if(s[i]==="=="||s[i]==="!="){let k=s[i++]==="==",T=l(s[i++]);return(b===T||String(b)===String(T))===k}return!!b},f=()=>{let u=c();for(;s[i]==="&&";)i++,u=c()&&u;return u},d=()=>{let u=f();for(;s[i]==="||";)i++,u=f()||u;return u},p=d();return i<s.length&&o(`unexpected "${s[i]}"`),p}function ct(t,e){let o=new Map;for(let s of t){if(!ut(s.when,e))continue;let[n,a]=s.group.split("@"),i=o.get(n)??[];i.push({order:Number(a)||0,entry:s}),o.set(n,i)}return[...o.keys()].sort((s,n)=>s==="navigation"?-1:n==="navigation"?1:s<n?-1:s>n?1:0).map(s=>o.get(s).sort((n,a)=>n.order-a.order).map(n=>n.entry))}function dt(t){let e=[];for(let o=t;o;o=o.parentElement){let s=o.dataset?.vscodeContext;if(s)try{e.push(JSON.parse(s))}catch{}}return Object.assign({},...e.reverse())}function xe(t,e,o){let s=t.defaultView,n=null;s.addEventListener("contextmenu",a=>{let i=a.target instanceof Element?a.target:null;if(!i||i.closest(".demo-menu"))return;n?.(!1);let l=dt(i),c=ct(e,l);if(!c.length)return;a.preventDefault();let f=t.activeElement instanceof HTMLElement?t.activeElement:null,d=t.createElement("div");d.className="demo-menu",d.setAttribute("role","menu"),c.forEach((y,I)=>{if(I){let R=t.createElement("div");R.setAttribute("role","separator"),d.append(R)}for(let R of y){let L=t.createElement("button");L.type="button",L.setAttribute("role","menuitem"),L.tabIndex=-1,L.textContent=R.title,L.addEventListener("click",()=>{n?.(!0),o(R.command,l)}),d.append(L)}}),t.body.append(d);let p=Array.from(d.querySelectorAll('[role="menuitem"]')),u=i.getBoundingClientRect(),b=a.clientX===0&&a.clientY===0,k=b?u.left:a.clientX,T=b?u.bottom:a.clientY,X=d.offsetWidth,J=d.offsetHeight;d.style.left=`${Math.max(0,k+X>s.innerWidth?s.innerWidth-X:k)}px`,d.style.top=`${Math.max(0,T+J>s.innerHeight?T-J:T)}px`;let Z=y=>{(!(y.target instanceof Node)||!d.contains(y.target))&&n?.(!1)},O=y=>{d.remove(),t.removeEventListener("pointerdown",Z,!0),s.removeEventListener("blur",ee),n=null,y&&f?.isConnected&&f.focus()},ee=()=>O(!1);n=O,t.addEventListener("pointerdown",Z,!0),s.addEventListener("blur",ee),d.addEventListener("keydown",y=>{let I=p.indexOf(t.activeElement),R=y.key==="ArrowDown"?(I+1)%p.length:y.key==="ArrowUp"?(I-1+p.length)%p.length:y.key==="Home"?0:y.key==="End"?p.length-1:-1;R>=0?(y.preventDefault(),p[R].focus()):(y.key==="Escape"||y.key==="Tab")&&(y.preventDefault(),O(!0))}),p[0].focus()})}function Se(t){return t==="pending-tools"||t==="awaiting-measurement"}function x(t){return typeof t=="string"&&t.length<=256*2&&Array.from(t).length<=256}function g(t){return typeof t=="number"&&Number.isSafeInteger(t)&&t>=0}function M(t){if(!t||typeof t!="object")return!1;let e=t;return x(e.session)&&!!e.session&&x(e.model)&&x(e.source)&&(e.provider==="claude"||e.provider==="codex")&&g(e.generation)&&g(e.request)}function D(t,e="unavailable"){return{...t,status:e,capturedAt:Date.now(),measurement:"provider-estimate",used:null,capacity:null,remaining:null,reserve:null,categories:[]}}function ve(t,e,o=Date.now()){if(e.provider==="codex")return pt(t,e,o);let s=D(e);if(!M(e)||e.provider!=="claude"||!t||typeof t!="object")return s;let n=t;if(!g(n.totalTokens)||!g(n.rawMaxTokens)||n.rawMaxTokens===0||!x(n.model)||!Array.isArray(n.categories)||n.categories.length>32)return s;let a=[],i=new Set,l=null,c=null;for(let d of n.categories){if(!d||typeof d!="object")return s;let p=d;if(!x(p.name)||!p.name.trim()||!g(p.tokens)||typeof p.kind!="string"||!["used","free","buffer","deferred"].includes(p.kind))return s;let u=p.name;if(i.has(u))return s;i.add(u),p.kind==="used"&&a.push({key:u,name:p.name,tokens:p.tokens,relationship:"used"}),p.kind==="free"&&(l=(l??0)+p.tokens),p.kind==="buffer"&&(c=(c??0)+p.tokens)}let f=a.reduce((d,p)=>d+p.tokens,0);return!g(f)||l!==null&&!g(l)||c!==null&&!g(c)?s:(a.sort((d,p)=>p.tokens-d.tokens),{...e,model:n.model,capturedAt:o,measurement:"provider-estimate",status:f===n.totalTokens?"available":"mismatch",used:n.totalTokens,capacity:n.rawMaxTokens,remaining:l,reserve:c,categories:a})}function pt(t,e,o){let s=D(e);if(!M(e)||!t||typeof t!="object")return s;let n=t;if(n.kind==="codex-context-unavailable")return n.session!==e.session||!x(n.model)||!n.model||e.model&&n.model!==e.model||!Se(n.reason)?s:{...s,capturedAt:o,reason:n.reason};if(n.kind!=="codex-retained-context"||!["request","retained-estimate"].includes(String(n.basis))||n.session!==e.session||!x(n.model)||!n.model||e.model&&n.model!==e.model||!g(n.used)||!g(n.capacity)||!n.capacity||!Array.isArray(n.categories)||!n.categories.length||n.categories.length>32)return s;let a={...e,model:n.model,capturedAt:o,measurement:"local-estimate",basis:n.basis,status:n.categories.reduce((i,l)=>i+(l?.tokens??NaN),0)===n.used?"available":"mismatch",used:n.used,capacity:n.capacity,remaining:Math.max(0,n.capacity-n.used),reserve:null,categories:n.categories.map(i=>({key:i?.key,name:i?.name,tokens:i?.tokens,relationship:i?.relationship}))};return P(a)?(a.categories.sort((i,l)=>l.tokens-i.tokens),a):s}function P(t){if(!M(t))return!1;let e=t;if(!["loading","available","mismatch","unavailable","stale"].includes(e.status)||e.reason!==void 0&&(e.status!=="unavailable"||e.provider!=="codex"||!Se(e.reason))||!g(e.capturedAt)||!["provider-estimate","local-estimate"].includes(e.measurement)||e.measurement==="local-estimate"&&(e.provider!=="codex"||e.reserve!==null)||e.measurement==="local-estimate"&&!["request","retained-estimate"].includes(String(e.basis))||![e.used,e.capacity,e.remaining,e.reserve].every(a=>a===null||g(a))||!Array.isArray(e.categories)||e.categories.length>32)return!1;let o=new Set;for(let a of e.categories){if(!a||!x(a.key)||!x(a.name)||!a.name.trim()||!g(a.tokens)||a.relationship!=="used"||o.has(a.key))return!1;o.add(a.key)}let s=e.status==="available"||e.status==="mismatch",n=e.categories.reduce((a,i)=>a+i.tokens,0);return s&&(e.used===null||!e.capacity||!g(n)||e.status==="available"!=(n===e.used))||!s&&(e.categories.length||e.used!==null||e.capacity!==null)?!1:new TextEncoder().encode(JSON.stringify({type:"contextDetail",detail:e})).length<=32768}var mt=5,gt=1048576;function Re(...t){let e=new Map;for(let o of t)if(Array.isArray(o))for(let s of o){if(!s||typeof s!="object")continue;let n=s;if(typeof n.id!="string"||!n.id||n.id.length>200||typeof n.source!="string"||n.source.length>200||typeof n.text!="string"||n.text.length>gt||!Number.isSafeInteger(n.order)||n.order<1||!Number.isSafeInteger(n.revision)||n.revision<0)continue;let a={id:n.id,order:n.order,source:n.source,revision:n.revision,text:n.text};typeof n.owner=="string"&&n.owner.length<=200&&Number.isSafeInteger(n.ownerRevision)&&n.ownerRevision>0&&(a.owner=n.owner,a.ownerRevision=n.ownerRevision,n.accepted===!0&&(a.accepted=!0)),n.setup&&(n.setup.agent==="claude"||n.setup.agent==="codex")&&["model","effort","permissionMode"].every(l=>typeof n.setup[l]=="string"&&n.setup[l].length<=200)&&(a.setup={agent:n.setup.agent,model:n.setup.model,effort:n.setup.effort,permissionMode:n.setup.permissionMode,source:n.setup.source==="inherited"||n.setup.source==="recent"?n.setup.source:"custom"});let i=e.get(n.id);if(i&&(i.order!==a.order||i.source!==a.source||i.revision!==a.revision||i.text!==a.text||i.setup&&a.setup&&["agent","model","effort","permissionMode","source"].some(l=>i.setup[l]!==a.setup[l])))throw new Error("The saved prompt conflicts with another copy.");(!i||(a.ownerRevision??0)>(i.ownerRevision??0))&&e.set(n.id,a)}return[...e.values()].sort((o,s)=>o.order-s.order||(o.id<s.id?-1:o.id>s.id?1:0)).slice(-mt)}var ke=64,yt=200;var ht=["claude","codex"];function j(t){return typeof t=="string"&&t.length<=yt?t:null}function Te(t){if(!t||typeof t!="object")return null;let e=t,o=ht.find(i=>i===e.agent),s=j(e.model),n=j(e.effort),a=j(e.permissionMode);return!o||s===null||n===null||a===null?null:{agent:o,model:s,effort:n,permissionMode:a}}var Le=["latest","cost-desc","cost-asc","needs-you"];var Ee=40,Ce=200,cr={taken:"A view already has that name. Choose another name.",unnamed:"A view needs a name. Type one to save it.",limit:`A name is cut to ${Ee} characters. Two names that agree that far are one view.`};var wt=Ce;var xt="needs-you",St="is:needsyou -is:archived -is:agentrun",vt=["All sessions","Running","Active","Unread","Needs input","Needs you","Custom"],Sr=new Set(vt.map(t=>Tt(t))),Me=["running","active","unread","input"],Rt={running:"is:running -is:archived -is:agentrun",active:"is:active -is:archived -is:agentrun",unread:"is:unread -is:archived -is:agentrun",input:"is:input -is:archived -is:agentrun"};var vr=wt+Math.max(St.length,...Me.map(t=>Rt[t].length))+1;function kt(t){return Me.includes(t)}function Pe(t){return kt(t)||t===xt}function Tt(t){return t.toLocaleLowerCase()}function _e(t){return typeof t=="object"&&t!==null&&!Array.isArray(t)}function Ae(t){return Number.isSafeInteger(t)&&t>=0}function Ne(t){return Array.isArray(t)&&t.every(e=>typeof e=="string")}function Ie(t){return t===void 0||_e(t)&&Ae(t.head)&&Ae(t.tail)&&Ne(t.ids)}function W(t){return t===void 0?!0:_e(t)&&Number.isSafeInteger(t.revision)&&(t.base===null||Number.isSafeInteger(t.base))&&(t.sessionsBase===void 0||t.sessionsBase===null||Number.isSafeInteger(t.sessionsBase))&&Ie(t.sessionOrder)&&Ie(t.railOrder)&&(t.statsRemoved===void 0||Ne(t.statsRemoved))}var Lt=["compact","one-column","two-columns"],Et=["above","below"];function B(t){return typeof t=="string"&&Lt.includes(t)}function K(t){return typeof t=="string"&&Et.includes(t)}var Ct={health:!0,visibility:!0,startupProgress:!0,contextDetail:!0,focusProjectSpend:!0,openLauncher:!0,labelEditor:!0,labelsChanged:!0,openLabelEditor:!0,showSessionDetails:!0,openViewEditor:!0,openSessionRename:!0,sessionRenameResult:!0,focusComposer:!0,pathCompletion:!0,insertPrompt:!0,fileStaging:!0,fileStagingRejected:!0,usage:!0,askRejected:!0,projectSpend:!0,layout:!0,live:!0,activity:!0,selection:!0,rail:!0,openPick:!0,takeDraft:!0,takeQueuedDraft:!0,promptRecovery:!0,requestPromptRecovery:!0,restoreDraft:!0,notes:!0,openComment:!0,sendSelectedText:!0,setRead:!0,forgetState:!0,setSessionRead:!0,setSessionArchived:!0,setSessionPinned:!0,setComposerHidden:!0,results:!0,render:!0};function m(t){return t!==null&&typeof t=="object"&&!Array.isArray(t)?t:null}function r(t){return typeof t=="string"}function v(t){return typeof t=="number"&&Number.isFinite(t)}function Mt(t){return r(t)&&Object.prototype.hasOwnProperty.call(Ct,t)}function Q(t){return t===void 0||r(t)}function S(t){return Array.isArray(t)&&t.every(e=>m(e)!==null)}function A(t){return Array.isArray(t)&&t.every(r)}function z(t){let e=m(t);return!!e&&r(e.name)&&v(e.count)&&r(e.countName)}function Pt(t){let e=m(t);return z(t)&&typeof e?.applied=="boolean"}function At(t){let e=m(t);return!!e&&r(e.id)&&e.id!==""&&r(e.name)&&r(e.query)&&typeof e.archived=="boolean"}function Y(t){return Array.isArray(t)&&t.every(At)}function It(t){let e=m(t);return!!e&&r(e.id)&&e.id!==""&&r(e.name)&&r(e.query)&&Le.includes(e.sort)&&(e.lens===void 0||e.lens===null||Pe(e.lens))}function G(t){return Array.isArray(t)&&t.every(It)}function De(t){let e=m(t);return!!e&&r(e.provisional)&&r(e.durable)}function _t(t){let e=m(t);return!!e&&r(e.id)&&r(e.label)&&r(e.name)&&v(e.size)&&(e.preview===null||r(e.preview))&&r(e.kind)&&r(e.stem)&&r(e.ext)&&r(e.sizeLabel)&&Q(e.removeLabel)&&Q(e.removeName)&&Q(e.removeControl)}function Nt(t){let e=m(t);return!!e&&r(e.name)&&typeof e.directory=="boolean"&&r(e.label)&&r(e.accessibleName)&&r(e.completion)}function Dt(t){let e=m(t);return!!e&&(e.kind==="prompt"||e.kind==="compact")&&(e.state==="sent"||e.state==="running"||e.state==="failed"||e.state==="done"||e.state==="interrupted")&&(e.tone==="running"||e.tone==="failed"||e.tone==="done"||e.tone==="interrupted")&&r(e.relative)&&r(e.absolute)&&r(e.agent)&&r(e.model)&&r(e.label)&&r(e.headline)&&r(e.status)&&r(e.reply)&&v(e.at)&&(e.since===null||v(e.since))&&r(e.dismissLabel)&&r(e.dismissName)&&r(e.dismissControl)&&r(e.restoreLabel)&&r(e.restoreName)&&r(e.restoreControl)&&r(e.reason)&&Array.isArray(e.files)&&e.files.every(_t)}function h(t,e){return typeof t=="string"?t:e}function Oe(t,e){return typeof t=="number"&&Number.isFinite(t)?t:e}var Ot=24,Ft=8,Ht=1e6;function $t(t){let e=Array.isArray(t.types)?t.types.filter(r).slice(0,Ot).map(s=>s.slice(0,120)):[],o=Array.isArray(t.values)?t.values.flatMap(s=>{let n=m(s);return n&&r(n.type)&&r(n.data)&&n.data.length<=Ht?[{type:n.type.slice(0,120),data:n.data}]:[]}).slice(0,Ft):[];return{types:e,values:o}}function Fe(t){let e=m(t);return e?e.kind==="row"&&r(e.key)?{kind:"row",key:e.key}:e.kind==="custom"&&r(e.agent)&&r(e.model)&&r(e.effort)&&r(e.permissionMode)?{kind:"custom",agent:e.agent,model:e.model,effort:e.effort,permissionMode:e.permissionMode}:null:null}function Vt(t){let e=m(t);if(!e)return null;if(e.decision==="allow")return{decision:"allow"};if(e.decision==="deny"&&r(e.reason))return{decision:"deny",reason:e.reason};if(e.decision==="answer"){let o=m(e.answers);if(!o)return null;let s={};for(let[n,a]of Object.entries(o)){let i=m(a);if(!i||!Array.isArray(i.labels)||!i.labels.every(r)||!r(i.written))return null;s[n]={labels:[...i.labels],written:i.written}}return{decision:"answer",answers:s}}return null}function He(t){let e=m(t);if(!e)return null;switch(e.type){case"health":return Number.isSafeInteger(e.sequence)&&e.sequence>0?{type:"health",sequence:e.sequence}:null;case"visibility":return typeof e.visible=="boolean"&&Number.isSafeInteger(e.revision)&&e.revision>=0?{type:"visibility",visible:e.visible,revision:e.revision}:null;case"startupProgress":return(e.complete===void 0||typeof e.complete=="boolean")&&(e.failed===void 0||typeof e.failed=="boolean")&&(e.held===void 0||typeof e.held=="boolean")&&Number.isSafeInteger(e.generation)&&Number.isSafeInteger(e.sequence)&&r(e.epoch)&&Number.isSafeInteger(e.completed)&&Number.isSafeInteger(e.known)&&e.generation>=0&&e.sequence>=0&&e.completed>=0&&e.known>=e.completed?e:null;case"focusProjectSpend":return{type:"focusProjectSpend"};case"openLauncher":return{type:"openLauncher",custom:e.custom===!0};case"labelEditor":return r(e.session)&&r(e.heading)&&Array.isArray(e.rows)&&e.rows.every(Pt)?{type:"labelEditor",session:e.session,heading:e.heading,rows:e.rows}:null;case"labelsChanged":return r(e.session)?{type:"labelsChanged",session:e.session}:null;case"openLabelEditor":return r(e.session)?{type:"openLabelEditor",session:e.session}:null;case"showSessionDetails":return r(e.session)&&e.session.length>0?{type:"showSessionDetails",session:e.session}:null;case"openViewEditor":return r(e.view)&&(e.mode==="rename"||e.mode==="delete")?{type:"openViewEditor",view:e.view,mode:e.mode}:null;case"openSessionRename":return r(e.session)&&e.session.length>0&&r(e.title)?{type:"openSessionRename",session:e.session,title:e.title}:null;case"sessionRenameResult":return r(e.session)&&e.session.length>0&&Number.isSafeInteger(e.request)&&r(e.title)&&r(e.error)?{type:"sessionRenameResult",session:e.session,request:e.request,title:e.title,error:e.error}:null;case"focusComposer":return r(e.session)?{type:"focusComposer",session:e.session}:null;case"contextDetail":return P(e.detail)?{type:"contextDetail",detail:e.detail}:M(e.detail)?{type:"contextDetail",detail:D({session:e.detail.session,provider:e.detail.provider,model:e.detail.model,source:e.detail.source,generation:e.detail.generation,request:e.detail.request})}:null;case"pathCompletion":return r(e.session)&&v(e.request)&&r(e.token)&&v(e.caret)&&Array.isArray(e.rows)&&e.rows.every(Nt)?{type:"pathCompletion",session:e.session,request:e.request,token:e.token,caret:e.caret,rows:e.rows}:null;case"insertPrompt":return r(e.session)&&r(e.text)?{type:"insertPrompt",session:e.session,text:e.text}:null;case"fileStaging":return r(e.session)?{type:"fileStaging",session:e.session,token:h(e.token,""),pending:e.pending===!0,...typeof e.count=="number"&&Number.isInteger(e.count)&&e.count>0?{count:e.count}:{}}:null;case"fileStagingRejected":return r(e.session)&&r(e.token)?{type:"fileStagingRejected",session:e.session,token:e.token}:null;case"usage":return{type:"usage",usage:e.usage};case"askRejected":return r(e.session)&&r(e.id)?{type:"askRejected",session:e.session,id:e.id}:null;case"projectSpend":return{type:"projectSpend",projectSpend:e.projectSpend};case"layout":{let o=m(e.layout);return o&&B(o.cardLayout)&&K(o.promptPosition)?{type:"layout",layout:{cardLayout:o.cardLayout,promptPosition:o.promptPosition}}:null}case"live":return r(e.session)&&Array.isArray(e.live)&&e.live.every(Dt)?{type:"live",session:e.session,live:e.live}:null;case"activity":return S(e.cards)?{type:"activity",cards:e.cards}:r(e.session)?{type:"activity",session:e.session,card:e.card}:null;case"selection":return S(e.cards)&&S(e.sessions)&&S(e.rail)&&m(e.stats)!==null&&A(e.replaces)?e:null;case"rail":{let o=m(e.stats),s=e.sessionAdoptions===void 0?[]:e.sessionAdoptions;return S(e.rail)&&o!==null&&Array.isArray(e.labels)&&e.labels.every(z)&&Y(e.views)&&G(e.railFilters)&&Array.isArray(s)&&s.every(De)&&A(e.hidden)&&A(e.pinnedTop)&&W(e.rows)?{type:"rail",rail:e.rail,stats:o,labels:e.labels,views:e.views,railFilters:e.railFilters,sessionAdoptions:s,hidden:e.hidden,pinnedTop:e.pinnedTop,...e.rows===void 0?{}:{rows:e.rows}}:null}case"openPick":return r(e.control)?{type:"openPick",control:e.control}:null;case"takeDraft":return r(e.session)&&r(e.text)?{type:"takeDraft",session:e.session,text:e.text}:null;case"takeQueuedDraft":return r(e.session)&&r(e.text)&&Number.isSafeInteger(e.revision)&&e.revision>=0&&r(e.value)?{type:"takeQueuedDraft",session:e.session,text:e.text,revision:e.revision,value:e.value}:null;case"promptRecovery":try{return{type:"promptRecovery",submittedPrompts:Re(e.submittedPrompts)}}catch{return null}case"requestPromptRecovery":return r(e.request)?{type:"requestPromptRecovery",request:e.request}:null;case"restoreDraft":return r(e.session)&&r(e.text)&&typeof e.revision=="number"?{type:"restoreDraft",session:e.session,text:e.text,revision:e.revision}:null;case"notes":return{type:"notes",comments:e.comments};case"openComment":return r(e.key)?{type:"openComment",key:e.key}:null;case"sendSelectedText":return r(e.key)&&e.key.length>0&&typeof e.copyLabels=="boolean"?{type:"sendSelectedText",key:e.key,copyLabels:e.copyLabels}:null;case"setRead":return r(e.key)?{type:"setRead",key:e.key,read:e.read===!0}:null;case"forgetState":return typeof e.since=="number"?{type:"forgetState",since:e.since}:null;case"setSessionRead":return r(e.session)?{type:"setSessionRead",session:e.session,read:e.read===!0}:null;case"setSessionArchived":return r(e.session)?{type:"setSessionArchived",session:e.session,archived:e.archived===!0}:null;case"setSessionPinned":return r(e.session)?{type:"setSessionPinned",session:e.session,pinned:e.pinned===!0}:null;case"setComposerHidden":return{type:"setComposerHidden",hidden:e.hidden===!0};case"results":return r(e.query)&&r(e.scope)?{type:"results",query:e.query,hits:e.hits,scope:e.scope}:null;case"render":{let o=e.sessionAdoptions;return S(e.cards)&&S(e.sessions)&&S(e.rail)&&m(e.stats)!==null&&A(e.hidden)&&A(e.pinnedTop)&&S(e.comments)&&Array.isArray(e.labels)&&e.labels.every(z)&&Y(e.views)&&G(e.railFilters)&&Array.isArray(e.iconFonts)&&e.iconFonts.every(r)&&Array.isArray(o)&&o.every(De)&&W(e.rows)?e:null}default:return null}}function $e(t){let e=m(t);if(!e)return null;switch(e.type){case"health":return Number.isSafeInteger(e.sequence)&&e.sequence>0?{type:"health",sequence:e.sequence}:null;case"ready":return{type:"ready"};case"painted":return Number.isSafeInteger(e.generation)&&e.generation>=0&&(e.stage==="railReady"||e.stage==="firstCard"||e.stage==="completeRender")?{type:"painted",generation:e.generation,stage:e.stage,...e.usableRows===!0?{usableRows:!0}:{}}:null;case"rowsGap":return{type:"rowsGap"};case"initialize":return{type:"initialize"};case"developmentReload":return{type:"developmentReload"};case"refresh":return{type:"refresh"};case"perf":return Mt(e.kind)&&v(e.ms)&&e.ms>=0?{type:"perf",kind:e.kind,ms:e.ms}:null;case"goBack":return{type:"goBack"};case"goForward":return{type:"goForward"};case"newSession":{if(e.owner!==void 0&&!r(e.owner))return null;let o=e.owner===void 0?{}:{owner:e.owner};if(e.request===void 0)return{type:"newSession",...o};let s=Fe(e.request);return s?{type:"newSession",request:s,...o}:null}case"pinSetup":{if(e.owner!==void 0&&!r(e.owner))return null;let o=e.owner===void 0?{}:{owner:e.owner},s=Fe(e.request);if(!s)return null;if(s.kind==="custom")return{type:"pinSetup",request:s,...o};let n=Te(m(e.request)?.values);return n?{type:"pinSetup",request:{...s,values:n},...o}:null}case"unpinSetup":return(e.owner===void 0||r(e.owner))&&r(e.id)&&e.id.trim().length>0&&e.id.length<=ke?{type:"unpinSetup",id:e.id,...e.owner===void 0?{}:{owner:e.owner}}:null;case"refreshUsage":return{type:"refreshUsage",agent:r(e.agent)?e.agent:null,force:e.force===!0};case"requestDefaults":return(e.agent==="claude"||e.agent==="codex")&&r(e.model)&&e.model.length<=200?{type:"requestDefaults",agent:e.agent,model:e.model}:null;case"openControl":return r(e.control)&&r(e.session)?{type:"openControl",control:e.control,session:e.session}:null;case"pick":return r(e.agent)&&r(e.value)&&r(e.session)?{type:"pick",control:String(e.control),agent:e.agent,session:e.session,model:h(e.model,""),value:e.value}:null;case"draft":return r(e.text)&&r(e.session)?{type:"draft",text:e.text,keep:h(e.keep,e.text),session:e.session,...Number.isSafeInteger(e.revision)?{revision:e.revision}:{}}:null;case"contextDetail":return x(e.session)&&e.session&&g(e.request)&&g(e.generation)?{type:"contextDetail",session:e.session,request:e.request,generation:e.generation}:null;case"pathCompletion":return r(e.session)&&v(e.request)&&r(e.token)&&v(e.caret)?{type:"pathCompletion",session:e.session,request:e.request,token:e.token,caret:e.caret}:null;case"answerAsk":{if(!r(e.session)||!r(e.id))return null;let o=Vt(e.answer);return o?{type:"answerAsk",session:e.session,id:e.id,answer:o}:null}case"dropUris":return r(e.session)?{type:"dropUris",session:e.session,...$t(e)}:null;case"beginFileStaging":return r(e.session)?{type:"beginFileStaging",session:e.session,token:h(e.token,"")}:null;case"attachFiles":return r(e.session)?{type:"attachFiles",session:e.session,token:h(e.token,""),clipboard:e.clipboard===!0,files:e.files}:null;case"fileReadError":return r(e.session)?{type:"fileReadError",session:e.session,token:h(e.token,""),name:h(e.name,"")}:null;case"fileRejected":return r(e.session)?{type:"fileRejected",session:e.session,code:h(e.code,"read"),name:h(e.name,""),size:Oe(e.size,0),rejected:Oe(e.rejected,0)}:null;case"removeFile":return r(e.session)&&r(e.value)?{type:"removeFile",session:e.session,value:e.value}:null;case"importPromptRecovery":return{type:"importPromptRecovery",submittedPrompts:e.submittedPrompts,...r(e.request)?{request:e.request}:{}};case"sendPrompt":return r(e.text)&&r(e.session)?{type:"sendPrompt",text:e.text,session:e.session,...e.attempt&&typeof e.attempt=="object"?{attempt:e.attempt}:{},revision:typeof e.revision=="number"&&Number.isSafeInteger(e.revision)&&e.revision>=0?e.revision:0}:null;case"compact":return r(e.session)?{type:"compact",session:e.session}:null;case"dismissLive":return r(e.session)?{type:"dismissLive",session:e.session,kind:h(e.kind,"")}:null;case"restoreLive":return r(e.session)?{type:"restoreLive",session:e.session,kind:h(e.kind,"")}:null;case"stopTurn":return r(e.session)?{type:"stopTurn",session:e.session}:null;case"dequeue":return r(e.value)&&r(e.session)?{type:"dequeue",value:e.value,session:e.session}:null;case"editQueued":return r(e.value)&&r(e.session)&&Number.isSafeInteger(e.revision)&&e.revision>=0?{type:"editQueued",value:e.value,session:e.session,revision:e.revision}:null;case"acceptQueuedEdit":return r(e.value)&&r(e.session)&&Number.isSafeInteger(e.revision)&&e.revision>=0&&Number.isSafeInteger(e.currentRevision)&&e.currentRevision>=0&&typeof e.accepted=="boolean"?{type:"acceptQueuedEdit",value:e.value,session:e.session,revision:e.revision,currentRevision:e.currentRevision,accepted:e.accepted}:null;case"copy":return r(e.text)?{type:"copy",text:e.text}:null;case"note":return{type:"note",note:e.note};case"armSelectedText":return r(e.session)&&e.session.length>0&&r(e.key)&&e.key.length>0?{type:"armSelectedText",session:e.session,key:e.key}:null;case"selectedTextHandoff":return r(e.session)&&e.session.length>0&&r(e.key)&&e.key.length>0&&r(e.text)&&e.text.trim().length>0&&typeof e.copyLabels=="boolean"?{type:"selectedTextHandoff",session:e.session,key:e.key,text:e.text,copyLabels:e.copyLabels}:null;case"armSessionDetails":return r(e.session)&&e.session.length>0?{type:"armSessionDetails",session:e.session}:null;case"armComposer":return{type:"armComposer"};case"showReaderParent":return r(e.session)&&e.session.length>0?{type:"showReaderParent",session:e.session}:null;case"showSession":return r(e.session)&&(e.responseLink===void 0||e.responseLink===!0)?{type:"showSession",session:e.session,...e.parent===!0?{parent:!0}:{},...e.responseLink===!0?{responseLink:!0}:{}}:null;case"labelEditor":return r(e.session)?{type:"labelEditor",session:e.session}:null;case"setLabels":return r(e.session)&&Array.isArray(e.names)?{type:"setLabels",session:e.session,names:e.names.filter(r)}:null;case"setViews":return Y(e.views)?{type:"setViews",views:e.views}:null;case"renameSession":return r(e.session)&&e.session.length>0&&Number.isSafeInteger(e.request)&&r(e.title)?{type:"renameSession",session:e.session,request:e.request,title:e.title}:null;case"setRailFilters":return G(e.railFilters)?{type:"setRailFilters",railFilters:e.railFilters}:null;case"sessionMembership":return r(e.session)?e.action==="pin"?e.openPinned!==void 0&&typeof e.openPinned!="boolean"?null:{type:"sessionMembership",action:e.action,session:e.session,...e.openPinned===!0?{openPinned:!0}:{}}:e.action==="archive"||e.action==="unarchive"||e.action==="unpin"?{type:"sessionMembership",action:e.action,session:e.session}:null:null;case"setLayout":return e.key==="cardLayout"&&B(e.value)?{type:"setLayout",key:"cardLayout",value:e.value}:e.key==="promptPosition"&&K(e.value)?{type:"setLayout",key:"promptPosition",value:e.value}:null;case"exportSession":return r(e.session)&&e.session.length>0?{type:"exportSession",session:e.session}:null;case"saveState":return{type:"saveState",state:e.state};case"search":return{type:"search",text:h(e.text,"")};case"loadOlder":return r(e.session)?{type:"loadOlder",session:e.session,token:h(e.token,"")}:null;case"openLink":if(e.destination!==void 0){let o=m(e.destination);return o&&o.kind==="fileCitation"&&r(o.path)&&e.href===void 0?{type:"openLink",destination:{kind:"fileCitation",path:o.path},beside:e.beside===!0}:null}return r(e.href)?{type:"openLink",href:e.href,beside:e.beside===!0}:null;case"openVisualization":return r(e.path)?{type:"openVisualization",path:e.path}:null;case"openImage":return r(e.path)?{type:"openImage",path:e.path,beside:e.beside===!0}:null;case"openTurnDiff":return r(e.key)?{type:"openTurnDiff",key:e.key,beside:e.beside===!0}:null;case"openCommit":return r(e.key)&&r(e.sha)?{type:"openCommit",key:e.key,sha:e.sha,dir:r(e.dir)?e.dir:null,beside:e.beside===!0}:null;case"openFile":return r(e.key)&&r(e.path)?{type:"openFile",key:e.key,path:e.path,beside:e.beside===!0,...r(e.sourceSessionId)?{sourceSessionId:e.sourceSessionId}:{}}:null;case"openSkill":return r(e.key)&&r(e.path)?{type:"openSkill",key:e.key,path:e.path,beside:e.beside===!0}:null;default:return null}}var qt={health:"noop",contextDetail:"handled",ready:"handled",rowsGap:"noop",painted:"noop",initialize:"noop",developmentReload:"noop",refresh:"noop",perf:"noop",goBack:"handled",goForward:"handled",newSession:"noop",pinSetup:"noop",unpinSetup:"noop",refreshUsage:"noop",openControl:"noop",requestDefaults:"noop",pick:"noop",draft:"noop",pathCompletion:"handled",answerAsk:"noop",beginFileStaging:"noop",attachFiles:"noop",dropUris:"noop",fileReadError:"noop",fileRejected:"noop",removeFile:"noop",sendPrompt:"noop",importPromptRecovery:"handled",compact:"noop",dismissLive:"noop",restoreLive:"noop",stopTurn:"noop",dequeue:"noop",editQueued:"noop",acceptQueuedEdit:"noop",copy:"handled",note:"handled",armSelectedText:"noop",selectedTextHandoff:"noop",armSessionDetails:"noop",armComposer:"noop",showReaderParent:"handled",showSession:"handled",labelEditor:"handled",setLabels:"handled",setViews:"handled",renameSession:"noop",setRailFilters:"handled",sessionMembership:"handled",setLayout:"handled",exportSession:"handled",saveState:"handled",search:"noop",loadOlder:"noop",openLink:"noop",openVisualization:"noop",openImage:"noop",openTurnDiff:"noop",openCommit:"noop",openFile:"noop",openSkill:"noop"};function Ut(t,e,o){let s=e.agent==="codex"?"codex":"claude",n=e.contextTokens,a=e.contextWindow??2e5,i=e.model??"",l=Math.floor(n*.12),c=Math.floor(n*.35),f=Math.floor(n*.38),d=[{key:"instructions",name:"Instructions",tokens:l,relationship:"used"},{key:"messages",name:"Messages",tokens:c,relationship:"used"},{key:"tools",name:"Tool results",tokens:f,relationship:"used"},{key:"other",name:s==="codex"?"Unattributed context":"Tool definitions",tokens:n-l-c-f,relationship:"used"}],p=s==="codex"?{kind:"codex-retained-context",basis:"request",session:t.session,model:i,used:n,capacity:a,categories:d}:{model:i,totalTokens:n,rawMaxTokens:a,categories:[...d.map(b=>({name:b.name,tokens:b.tokens,kind:"used"})),{name:"Free space",tokens:Math.max(0,a-n-Math.floor(a*.1)),kind:"free"},{name:"Compaction buffer",tokens:Math.floor(a*.1),kind:"buffer"}]},u=ve(p,{...t,provider:s,model:i,source:"demo"},o);if(!P(u)||u.status!=="available")throw new Error("Invalid demo context detail");return{type:"contextDetail",detail:u}}var Ve={policy:qt,parsePanelToHost:$e,parseHostToPanel:He,contextReply:Ut};window.__ARC_DEMO_SAMPLES__.host=Ve;window.__ARC_DEMO_SAMPLES__.labelRules={labelCounts:V,labelEditorReply:ie,labelsOf:$,railLabelFields:se,setSessionLabels:oe};window.__ARC_DEMO_SAMPLES__.readRules={newBySession:le};window.__ARC_DEMO_SAMPLES__.commentRules={applyComment:de,normalizeComments:E};window.__ARC_DEMO_SAMPLES__.placeRules={emptyTrail:pe,visitPlace:fe,stepBack:me,stepForward:ge,trailPlace:U};window.__ARC_DEMO_SAMPLES__.isSendChord=ye;window.__ARC_DEMO_SAMPLES__.navigationShortcut=he;window.__ARC_DEMO_SAMPLES__.parseSessionLink=we;window.__ARC_DEMO_SAMPLES__.installMenu=xe;})();
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
