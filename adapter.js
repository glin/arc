(()=>{function _(t,e,o){if(t.length<=e)return t;let s=t.slice(0,Math.max(0,e-o.length)),n=s.charCodeAt(s.length-1);return n>=55296&&n<=56319&&(s=s.slice(0,-1)),s+o}var _e=/[\p{Cc}\p{Cf}\p{Cs}]/gu,Ne=/[\u200c\u200d\u{e0020}-\u{e007f}]/u,De=/\u200d+$/u,Oe=/[^\p{White_Space}\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]/u;function N(t,e){if(typeof t!="string")return"";let n=t.normalize("NFC").replace(/\p{White_Space}+/gu," ").replace(_e,i=>Ne.test(i)?i:"").normalize("NFC").trim(),a=_(n,e,"").replace(De,"").trim();return Oe.test(a)?a:""}function x(t){return t.toLocaleLowerCase()}function F(t){return t===1?"carried by one session":`carried by ${t} sessions`}var He=20,$e=500,Ve=2;function H(t){return N(t,40)}function ee(t,e){let o=[],s=new Set;for(let n of t){let a=H(n);if(!a)continue;let i=x(a),l=e.get(i);if(l===void 0&&e.set(i,a),!s.has(i)&&(s.add(i),o.push(l??a),o.length===He))break}return o}function $(t,e){let o=Object.prototype.hasOwnProperty.call(t,e)?t[e]:null;return Array.isArray(o)?[...o]:[]}function ne(t,e,o){let s=!!e&&e!=="__proto__"&&ee(o,new Map).length>0,n=[];for(let[c,m]of Object.entries(t))c!==e&&c!=="__proto__"&&n.push([c,m]);let a=$e-(s?1:0),i=new Map,l={};for(let[c,m]of n.slice(Math.max(0,n.length-Math.max(0,a)))){l[c]=[...m];for(let p of m){let d=x(p);i.has(d)||i.set(d,p)}}return s&&(l[e]=ee(o,i)),l}function qe(t){let e=t.slice(0,Ve),o=t.slice(e.length);return{chips:e,more:o.length?`+${o.length}`:null,rest:o}}function re(t,e){let{chips:o,more:s,rest:n}=qe(t);return{labels:[...t],labelChips:o,labelsMore:s,labelsMoreName:n.length?n.join(", "):null,labelClause:t.length?`${e} ${t.join(", ")}`:null}}function V(t){let e=new Map;for(let[o,s]of Object.entries(t)){if(!o||o==="__proto__"||!Array.isArray(s))continue;let n=new Set;for(let a of s){let i=H(a);if(!i)continue;let l=x(i);if(n.has(l))continue;n.add(l);let c=e.get(l);c?c.count+=1:e.set(l,{name:i,count:1})}}return[...e.values()].sort((o,s)=>s.count-o.count||o.name.localeCompare(s.name)).map(o=>({...o,countName:F(o.count)}))}function Ue(t,e){let o=V(t),s=new Map(o.map(i=>[x(i.name),i])),n=new Set,a=[];for(let i of $(t,e)){let l=H(i);if(!l)continue;let c=x(l),m=s.get(c);!m||n.has(c)||(n.add(c),a.push({...m,applied:!0}))}for(let i of o)n.has(x(i.name))||a.push({...i,applied:!1});return a}function oe(t,e,o,s,n=o){let a=e.find(i=>i.id===o)?.label??o;return{type:"labelEditor",session:n,heading:`${s} ${a}`,rows:Ue(t,o)}}function se(t,e,o,s=0){if(e.has(t.key))return!0;let n=o.get(t.sessionId)??s;return n>0&&t.startedAt<=n}function ie(t,e,o,s=0){let n=new Set(e),a=new Map;for(let l of t){if(l.kind!=="turn"||!se(l,n,o,s))continue;let c=a.get(l.sessionId);(c===void 0||l.startedAt>c)&&a.set(l.sessionId,l.startedAt)}let i=new Map;for(let l of t){if(l.kind!=="turn"||(i.has(l.sessionId)||i.set(l.sessionId,0),se(l,n,o,s)))continue;let c=a.get(l.sessionId);c!==void 0&&l.startedAt<=c||i.set(l.sessionId,i.get(l.sessionId)+1)}return i}var q="…";function ae(t){return!!t&&/^\S{1,200}$/.test(t)}var Ke=200,le=6e3,C=2e3,Be=/^answer:\d{1,4}$/,Qe=/^prompt:\d{1,4}$/;function ze(t){return t==="prompt"||t==="summary"||typeof t=="string"&&Be.test(t)||typeof t=="string"&&Qe.test(t)||typeof t=="string"&&t.startsWith("said:")&&ae(t.slice(5))?t:"summary"}function Ye(t){if(!t||typeof t!="object"||Array.isArray(t))return null;let e=t,o=(p,d)=>typeof p=="string"?_(p,d,q):"",s=p=>typeof p=="number"&&Number.isFinite(p)?p:null,n=o(e.id,C),a=o(e.sessionId,C),i=o(e.turnKey,C),l=o(e.note,le).trim(),c=s(e.at),m=s(e.turnAt);return!n||!a||!i||!l||c===null||m===null?null:{id:n,sessionId:a,turnKey:i,part:ze(e.part),quote:o(e.quote,le),offset:typeof e.offset=="number"&&Number.isFinite(e.offset)&&e.offset>=0?Math.trunc(e.offset):void 0,note:l,headline:o(e.headline,C),sessionTitle:o(e.sessionTitle,C),turnAt:m,at:c}}function L(t){let e=[];if(Array.isArray(t))for(let o of t){let s=Ye(o);s&&e.push(s)}return e.slice(Math.max(0,e.length-Ke))}function ue(t,e){if(!e||typeof e!="object")return[...t];let o=e;if(o.op==="clear"){let i=typeof o.sessionId=="string"?o.sessionId:"";return i?L(t.filter(l=>l.sessionId!==i)):[...t]}if(o.op==="delete"){let i=typeof o.id=="string"?o.id:"";return i?L(t.filter(l=>l.id!==i)):[...t]}if(o.op!=="write")return[...t];let[s]=L([o.note]);if(!s)return[...t];let n=t.findIndex(i=>i.id===s.id),a=[...t];return n<0?a.push(s):a[n]=s,L(a)}function ce(){return{places:[],at:-1}}function U(t){return t.at>=0&&t.at<t.places.length?t.places[t.at]:null}function Xe(t){return t.at>0}function Ge(t){return t.at>=0&&t.at<t.places.length-1}function pe(t,e){if(!e||U(t)===e)return t;let o=t.places.slice(0,t.at+1);return o.push(e),Je({places:o,at:o.length-1})}function de(t){return Xe(t)?{places:t.places,at:t.at-1}:null}function me(t){return Ge(t)?{places:t.places,at:t.at+1}:null}function Je(t){if(t.places.length<=50)return t;let e=t.places.length-50;return{places:t.places.slice(e),at:t.at-e}}function Ze(t){return/^Mac/.test(t||"")}function fe(t,e){return!t||t.key!=="Enter"||t.altKey||t.shiftKey?!1:Ze(e)?!!t.metaKey&&!t.ctrlKey:!!t.ctrlKey&&!t.metaKey}var et="`",Tn=et.repeat(3);function ge(t,e){if(t.defaultPrevented||t.isComposing||t.keyCode===229||t.metaKey)return null;if(/^Win/.test(e))return!t.altKey||t.ctrlKey||t.shiftKey?null:t.key==="ArrowLeft"?"goBack":t.key==="ArrowRight"?"goForward":null;if((t.key==="-"||t.code==="Minus")&&t.ctrlKey){if(t.shiftKey&&!t.altKey)return"goForward";if(!t.shiftKey&&t.altKey===!/^Mac/.test(e))return"goBack"}return null}function tt(t,e){if(!t.trim())return!0;let o=u=>{throw new Error(`The menu stand-in cannot read the when clause "${t}": ${u}.`)},s=[],n=/\s*('[^']*'|==|!=|&&|\|\||[!()]|[A-Za-z_][\w.:-]*)/y;for(;n.lastIndex<t.length&&t.slice(n.lastIndex).trim();){let u=n.lastIndex,b=n.exec(t);b||o(`unsupported text at "${t.slice(u).trim()}"`),s.push(b[1])}let a=u=>u!==void 0&&/^[A-Za-z_]/.test(u),i=0,l=u=>u?.startsWith("'")?u.slice(1,-1):(a(u)||o(`a comparison has no value after "${s[i-2]} ${s[i-1]}"`),u==="true"?!0:u==="false"?!1:u),c=()=>{let u=s[i++];if(u==="("){let R=p();return s[i++]!==")"&&o("a parenthesis is not closed"),R}if(u==="!")return!c();a(u)||o(u===void 0?"it ends early":`unexpected "${u}"`);let b=e[u];if(s[i]==="=="||s[i]==="!="){let R=s[i++]==="==",T=l(s[i++]);return(b===T||String(b)===String(T))===R}return!!b},m=()=>{let u=c();for(;s[i]==="&&";)i++,u=c()&&u;return u},p=()=>{let u=m();for(;s[i]==="||";)i++,u=m()||u;return u},d=p();return i<s.length&&o(`unexpected "${s[i]}"`),d}function nt(t,e){let o=new Map;for(let s of t){if(!tt(s.when,e))continue;let[n,a]=s.group.split("@"),i=o.get(n)??[];i.push({order:Number(a)||0,entry:s}),o.set(n,i)}return[...o.keys()].sort((s,n)=>s==="navigation"?-1:n==="navigation"?1:s<n?-1:s>n?1:0).map(s=>o.get(s).sort((n,a)=>n.order-a.order).map(n=>n.entry))}function rt(t){let e=[];for(let o=t;o;o=o.parentElement){let s=o.dataset?.vscodeContext;if(s)try{e.push(JSON.parse(s))}catch{}}return Object.assign({},...e.reverse())}function ye(t,e,o){let s=t.defaultView,n=null;s.addEventListener("contextmenu",a=>{let i=a.target instanceof Element?a.target:null;if(!i||i.closest(".demo-menu"))return;n?.(!1);let l=rt(i),c=nt(e,l);if(!c.length)return;a.preventDefault();let m=t.activeElement instanceof HTMLElement?t.activeElement:null,p=t.createElement("div");p.className="demo-menu",p.setAttribute("role","menu"),c.forEach((y,I)=>{if(I){let k=t.createElement("div");k.setAttribute("role","separator"),p.append(k)}for(let k of y){let E=t.createElement("button");E.type="button",E.setAttribute("role","menuitem"),E.tabIndex=-1,E.textContent=k.title,E.addEventListener("click",()=>{n?.(!0),o(k.command,l)}),p.append(E)}}),t.body.append(p);let d=Array.from(p.querySelectorAll('[role="menuitem"]')),u=i.getBoundingClientRect(),b=a.clientX===0&&a.clientY===0,R=b?u.left:a.clientX,T=b?u.bottom:a.clientY,X=p.offsetWidth,G=p.offsetHeight;p.style.left=`${Math.max(0,R+X>s.innerWidth?s.innerWidth-X:R)}px`,p.style.top=`${Math.max(0,T+G>s.innerHeight?T-G:T)}px`;let J=y=>{(!(y.target instanceof Node)||!p.contains(y.target))&&n?.(!1)},O=y=>{p.remove(),t.removeEventListener("pointerdown",J,!0),s.removeEventListener("blur",Z),n=null,y&&m?.isConnected&&m.focus()},Z=()=>O(!1);n=O,t.addEventListener("pointerdown",J,!0),s.addEventListener("blur",Z),p.addEventListener("keydown",y=>{let I=d.indexOf(t.activeElement),k=y.key==="ArrowDown"?(I+1)%d.length:y.key==="ArrowUp"?(I-1+d.length)%d.length:y.key==="Home"?0:y.key==="End"?d.length-1:-1;k>=0?(y.preventDefault(),d[k].focus()):(y.key==="Escape"||y.key==="Tab")&&(y.preventDefault(),O(!0))}),d[0].focus()})}function he(t){return t==="pending-tools"||t==="awaiting-measurement"}function S(t){return typeof t=="string"&&t.length<=256*2&&Array.from(t).length<=256}function g(t){return typeof t=="number"&&Number.isSafeInteger(t)&&t>=0}function P(t){if(!t||typeof t!="object")return!1;let e=t;return S(e.session)&&!!e.session&&S(e.model)&&S(e.source)&&(e.provider==="claude"||e.provider==="codex")&&g(e.generation)&&g(e.request)}function D(t,e="unavailable"){return{...t,status:e,capturedAt:Date.now(),measurement:"provider-estimate",used:null,capacity:null,remaining:null,reserve:null,categories:[]}}function be(t,e,o=Date.now()){if(e.provider==="codex")return ot(t,e,o);let s=D(e);if(!P(e)||e.provider!=="claude"||!t||typeof t!="object")return s;let n=t;if(!g(n.totalTokens)||!g(n.rawMaxTokens)||n.rawMaxTokens===0||!S(n.model)||!Array.isArray(n.categories)||n.categories.length>32)return s;let a=[],i=new Set,l=null,c=null;for(let p of n.categories){if(!p||typeof p!="object")return s;let d=p;if(!S(d.name)||!d.name.trim()||!g(d.tokens)||typeof d.kind!="string"||!["used","free","buffer","deferred"].includes(d.kind))return s;let u=d.name;if(i.has(u))return s;i.add(u),d.kind==="used"&&a.push({key:u,name:d.name,tokens:d.tokens,relationship:"used"}),d.kind==="free"&&(l=(l??0)+d.tokens),d.kind==="buffer"&&(c=(c??0)+d.tokens)}let m=a.reduce((p,d)=>p+d.tokens,0);return!g(m)||l!==null&&!g(l)||c!==null&&!g(c)?s:(a.sort((p,d)=>d.tokens-p.tokens),{...e,model:n.model,capturedAt:o,measurement:"provider-estimate",status:m===n.totalTokens?"available":"mismatch",used:n.totalTokens,capacity:n.rawMaxTokens,remaining:l,reserve:c,categories:a})}function ot(t,e,o){let s=D(e);if(!P(e)||!t||typeof t!="object")return s;let n=t;if(n.kind==="codex-context-unavailable")return n.session!==e.session||!S(n.model)||!n.model||e.model&&n.model!==e.model||!he(n.reason)?s:{...s,capturedAt:o,reason:n.reason};if(n.kind!=="codex-retained-context"||!["request","retained-estimate"].includes(String(n.basis))||n.session!==e.session||!S(n.model)||!n.model||e.model&&n.model!==e.model||!g(n.used)||!g(n.capacity)||!n.capacity||!Array.isArray(n.categories)||!n.categories.length||n.categories.length>32)return s;let a={...e,model:n.model,capturedAt:o,measurement:"local-estimate",basis:n.basis,status:n.categories.reduce((i,l)=>i+(l?.tokens??NaN),0)===n.used?"available":"mismatch",used:n.used,capacity:n.capacity,remaining:Math.max(0,n.capacity-n.used),reserve:null,categories:n.categories.map(i=>({key:i?.key,name:i?.name,tokens:i?.tokens,relationship:i?.relationship}))};return M(a)?(a.categories.sort((i,l)=>l.tokens-i.tokens),a):s}function M(t){if(!P(t))return!1;let e=t;if(!["loading","available","mismatch","unavailable","stale"].includes(e.status)||e.reason!==void 0&&(e.status!=="unavailable"||e.provider!=="codex"||!he(e.reason))||!g(e.capturedAt)||!["provider-estimate","local-estimate"].includes(e.measurement)||e.measurement==="local-estimate"&&(e.provider!=="codex"||e.reserve!==null)||e.measurement==="local-estimate"&&!["request","retained-estimate"].includes(String(e.basis))||![e.used,e.capacity,e.remaining,e.reserve].every(a=>a===null||g(a))||!Array.isArray(e.categories)||e.categories.length>32)return!1;let o=new Set;for(let a of e.categories){if(!a||!S(a.key)||!S(a.name)||!a.name.trim()||!g(a.tokens)||a.relationship!=="used"||o.has(a.key))return!1;o.add(a.key)}let s=e.status==="available"||e.status==="mismatch",n=e.categories.reduce((a,i)=>a+i.tokens,0);return s&&(e.used===null||!e.capacity||!g(n)||e.status==="available"!=(n===e.used))||!s&&(e.categories.length||e.used!==null||e.capacity!==null)?!1:new TextEncoder().encode(JSON.stringify({type:"contextDetail",detail:e})).length<=32768}var it=5,at=1048576;function xe(...t){let e=new Map;for(let o of t)if(Array.isArray(o))for(let s of o){if(!s||typeof s!="object")continue;let n=s;if(typeof n.id!="string"||!n.id||n.id.length>200||typeof n.source!="string"||n.source.length>200||typeof n.text!="string"||n.text.length>at||!Number.isSafeInteger(n.order)||n.order<1||!Number.isSafeInteger(n.revision)||n.revision<0)continue;let a={id:n.id,order:n.order,source:n.source,revision:n.revision,text:n.text};typeof n.owner=="string"&&n.owner.length<=200&&Number.isSafeInteger(n.ownerRevision)&&n.ownerRevision>0&&(a.owner=n.owner,a.ownerRevision=n.ownerRevision,n.accepted===!0&&(a.accepted=!0)),n.setup&&(n.setup.agent==="claude"||n.setup.agent==="codex")&&["model","effort","permissionMode"].every(l=>typeof n.setup[l]=="string"&&n.setup[l].length<=200)&&(a.setup={agent:n.setup.agent,model:n.setup.model,effort:n.setup.effort,permissionMode:n.setup.permissionMode,source:n.setup.source==="inherited"||n.setup.source==="recent"?n.setup.source:"custom"});let i=e.get(n.id);if(i&&(i.order!==a.order||i.source!==a.source||i.revision!==a.revision||i.text!==a.text||i.setup&&a.setup&&["agent","model","effort","permissionMode","source"].some(l=>i.setup[l]!==a.setup[l])))throw new Error("The saved prompt conflicts with another copy.");(!i||(a.ownerRevision??0)>(i.ownerRevision??0))&&e.set(n.id,a)}return[...e.values()].sort((o,s)=>o.order-s.order||(o.id<s.id?-1:o.id>s.id?1:0)).slice(-it)}var Se=64,lt=200;var ut=["claude","codex"];function j(t){return typeof t=="string"&&t.length<=lt?t:null}function we(t){if(!t||typeof t!="object")return null;let e=t,o=ut.find(i=>i===e.agent),s=j(e.model),n=j(e.effort),a=j(e.permissionMode);return!o||s===null||n===null||a===null?null:{agent:o,model:s,effort:n,permissionMode:a}}var ve=["latest","cost-desc","cost-asc","needs-you"];var ke=40,Re=200,Jn={taken:"A view already has that name. Choose another name.",unnamed:"A view needs a name. Type one to save it.",limit:`A name is cut to ${ke} characters. Two names that agree that far are one view.`};var pt=Re;var dt="needs-you",mt="is:needsyou -is:archived -is:agentrun",ft=["All sessions","Running","Active","Unread","Needs input","Needs you","Custom"],ur=new Set(ft.map(t=>ht(t))),Te=["running","active","unread","input"],gt={running:"is:running -is:archived -is:agentrun",active:"is:active -is:archived -is:agentrun",unread:"is:unread -is:archived -is:agentrun",input:"is:input -is:archived -is:agentrun"};var cr=pt+Math.max(mt.length,...Te.map(t=>gt[t].length))+1;function yt(t){return Te.includes(t)}function Ee(t){return yt(t)||t===dt}function ht(t){return t.toLocaleLowerCase()}var bt=["compact","one-column","two-columns"],xt=["above","below"];function W(t){return typeof t=="string"&&bt.includes(t)}function K(t){return typeof t=="string"&&xt.includes(t)}var St={health:!0,visibility:!0,startupProgress:!0,contextDetail:!0,focusProjectSpend:!0,openLauncher:!0,labelEditor:!0,labelsChanged:!0,openLabelEditor:!0,showSessionDetails:!0,openViewEditor:!0,openSessionRename:!0,sessionRenameResult:!0,focusComposer:!0,pathCompletion:!0,insertPrompt:!0,fileStaging:!0,fileStagingRejected:!0,usage:!0,askRejected:!0,projectSpend:!0,layout:!0,live:!0,activity:!0,selection:!0,rail:!0,openPick:!0,takeDraft:!0,takeQueuedDraft:!0,promptRecovery:!0,requestPromptRecovery:!0,restoreDraft:!0,notes:!0,openComment:!0,sendSelectedText:!0,setRead:!0,forgetState:!0,setSessionRead:!0,setSessionArchived:!0,setSessionPinned:!0,setComposerHidden:!0,results:!0,render:!0};function f(t){return t!==null&&typeof t=="object"&&!Array.isArray(t)?t:null}function r(t){return typeof t=="string"}function v(t){return typeof t=="number"&&Number.isFinite(t)}function wt(t){return r(t)&&Object.prototype.hasOwnProperty.call(St,t)}function B(t){return t===void 0||r(t)}function w(t){return Array.isArray(t)&&t.every(e=>f(e)!==null)}function A(t){return Array.isArray(t)&&t.every(r)}function Q(t){let e=f(t);return!!e&&r(e.name)&&v(e.count)&&r(e.countName)}function vt(t){let e=f(t);return Q(t)&&typeof e?.applied=="boolean"}function kt(t){let e=f(t);return!!e&&r(e.id)&&e.id!==""&&r(e.name)&&r(e.query)&&typeof e.archived=="boolean"}function z(t){return Array.isArray(t)&&t.every(kt)}function Rt(t){let e=f(t);return!!e&&r(e.id)&&e.id!==""&&r(e.name)&&r(e.query)&&ve.includes(e.sort)&&(e.lens===void 0||e.lens===null||Ee(e.lens))}function Y(t){return Array.isArray(t)&&t.every(Rt)}function Le(t){let e=f(t);return!!e&&r(e.provisional)&&r(e.durable)}function Tt(t){let e=f(t);return!!e&&r(e.id)&&r(e.label)&&r(e.name)&&v(e.size)&&(e.preview===null||r(e.preview))&&r(e.kind)&&r(e.stem)&&r(e.ext)&&r(e.sizeLabel)&&B(e.removeLabel)&&B(e.removeName)&&B(e.removeControl)}function Et(t){let e=f(t);return!!e&&r(e.name)&&typeof e.directory=="boolean"&&r(e.label)&&r(e.accessibleName)&&r(e.completion)}function Lt(t){let e=f(t);return!!e&&(e.kind==="prompt"||e.kind==="compact")&&(e.state==="sent"||e.state==="running"||e.state==="failed"||e.state==="done"||e.state==="interrupted")&&(e.tone==="running"||e.tone==="failed"||e.tone==="done"||e.tone==="interrupted")&&r(e.relative)&&r(e.absolute)&&r(e.agent)&&r(e.model)&&r(e.label)&&r(e.headline)&&r(e.status)&&r(e.reply)&&v(e.at)&&(e.since===null||v(e.since))&&r(e.dismissLabel)&&r(e.dismissName)&&r(e.dismissControl)&&r(e.restoreLabel)&&r(e.restoreName)&&r(e.restoreControl)&&r(e.reason)&&Array.isArray(e.files)&&e.files.every(Tt)}function h(t,e){return typeof t=="string"?t:e}function Ce(t,e){return typeof t=="number"&&Number.isFinite(t)?t:e}var Ct=24,Pt=8,Mt=1e6;function At(t){let e=Array.isArray(t.types)?t.types.filter(r).slice(0,Ct).map(s=>s.slice(0,120)):[],o=Array.isArray(t.values)?t.values.flatMap(s=>{let n=f(s);return n&&r(n.type)&&r(n.data)&&n.data.length<=Mt?[{type:n.type.slice(0,120),data:n.data}]:[]}).slice(0,Pt):[];return{types:e,values:o}}function Pe(t){let e=f(t);return e?e.kind==="row"&&r(e.key)?{kind:"row",key:e.key}:e.kind==="custom"&&r(e.agent)&&r(e.model)&&r(e.effort)&&r(e.permissionMode)?{kind:"custom",agent:e.agent,model:e.model,effort:e.effort,permissionMode:e.permissionMode}:null:null}function It(t){let e=f(t);if(!e)return null;if(e.decision==="allow")return{decision:"allow"};if(e.decision==="deny"&&r(e.reason))return{decision:"deny",reason:e.reason};if(e.decision==="answer"){let o=f(e.answers);if(!o)return null;let s={};for(let[n,a]of Object.entries(o)){let i=f(a);if(!i||!Array.isArray(i.labels)||!i.labels.every(r)||!r(i.written))return null;s[n]={labels:[...i.labels],written:i.written}}return{decision:"answer",answers:s}}return null}function Me(t){let e=f(t);if(!e)return null;switch(e.type){case"health":return Number.isSafeInteger(e.sequence)&&e.sequence>0?{type:"health",sequence:e.sequence}:null;case"visibility":return typeof e.visible=="boolean"&&Number.isSafeInteger(e.revision)&&e.revision>=0?{type:"visibility",visible:e.visible,revision:e.revision}:null;case"startupProgress":return(e.complete===void 0||typeof e.complete=="boolean")&&(e.failed===void 0||typeof e.failed=="boolean")&&(e.held===void 0||typeof e.held=="boolean")&&Number.isSafeInteger(e.generation)&&Number.isSafeInteger(e.sequence)&&r(e.epoch)&&Number.isSafeInteger(e.completed)&&Number.isSafeInteger(e.known)&&e.generation>=0&&e.sequence>=0&&e.completed>=0&&e.known>=e.completed?e:null;case"focusProjectSpend":return{type:"focusProjectSpend"};case"openLauncher":return{type:"openLauncher",custom:e.custom===!0};case"labelEditor":return r(e.session)&&r(e.heading)&&Array.isArray(e.rows)&&e.rows.every(vt)?{type:"labelEditor",session:e.session,heading:e.heading,rows:e.rows}:null;case"labelsChanged":return r(e.session)?{type:"labelsChanged",session:e.session}:null;case"openLabelEditor":return r(e.session)?{type:"openLabelEditor",session:e.session}:null;case"showSessionDetails":return r(e.session)&&e.session.length>0?{type:"showSessionDetails",session:e.session}:null;case"openViewEditor":return r(e.view)&&(e.mode==="rename"||e.mode==="delete")?{type:"openViewEditor",view:e.view,mode:e.mode}:null;case"openSessionRename":return r(e.session)&&e.session.length>0&&r(e.title)?{type:"openSessionRename",session:e.session,title:e.title}:null;case"sessionRenameResult":return r(e.session)&&e.session.length>0&&Number.isSafeInteger(e.request)&&r(e.title)&&r(e.error)?{type:"sessionRenameResult",session:e.session,request:e.request,title:e.title,error:e.error}:null;case"focusComposer":return r(e.session)?{type:"focusComposer",session:e.session}:null;case"contextDetail":return M(e.detail)?{type:"contextDetail",detail:e.detail}:P(e.detail)?{type:"contextDetail",detail:D({session:e.detail.session,provider:e.detail.provider,model:e.detail.model,source:e.detail.source,generation:e.detail.generation,request:e.detail.request})}:null;case"pathCompletion":return r(e.session)&&v(e.request)&&r(e.token)&&v(e.caret)&&Array.isArray(e.rows)&&e.rows.every(Et)?{type:"pathCompletion",session:e.session,request:e.request,token:e.token,caret:e.caret,rows:e.rows}:null;case"insertPrompt":return r(e.session)&&r(e.text)?{type:"insertPrompt",session:e.session,text:e.text}:null;case"fileStaging":return r(e.session)?{type:"fileStaging",session:e.session,token:h(e.token,""),pending:e.pending===!0,...typeof e.count=="number"&&Number.isInteger(e.count)&&e.count>0?{count:e.count}:{}}:null;case"fileStagingRejected":return r(e.session)&&r(e.token)?{type:"fileStagingRejected",session:e.session,token:e.token}:null;case"usage":return{type:"usage",usage:e.usage};case"askRejected":return r(e.session)&&r(e.id)?{type:"askRejected",session:e.session,id:e.id}:null;case"projectSpend":return{type:"projectSpend",projectSpend:e.projectSpend};case"layout":{let o=f(e.layout);return o&&W(o.cardLayout)&&K(o.promptPosition)?{type:"layout",layout:{cardLayout:o.cardLayout,promptPosition:o.promptPosition}}:null}case"live":return r(e.session)&&Array.isArray(e.live)&&e.live.every(Lt)?{type:"live",session:e.session,live:e.live}:null;case"activity":return w(e.cards)?{type:"activity",cards:e.cards}:r(e.session)?{type:"activity",session:e.session,card:e.card}:null;case"selection":return w(e.cards)&&w(e.sessions)&&w(e.rail)&&f(e.stats)!==null&&A(e.replaces)?e:null;case"rail":{let o=f(e.stats),s=e.sessionAdoptions===void 0?[]:e.sessionAdoptions;return w(e.rail)&&o!==null&&Array.isArray(e.labels)&&e.labels.every(Q)&&z(e.views)&&Y(e.railFilters)&&Array.isArray(s)&&s.every(Le)&&A(e.hidden)&&A(e.pinnedTop)?{type:"rail",rail:e.rail,stats:o,labels:e.labels,views:e.views,railFilters:e.railFilters,sessionAdoptions:s,hidden:e.hidden,pinnedTop:e.pinnedTop}:null}case"openPick":return r(e.control)?{type:"openPick",control:e.control}:null;case"takeDraft":return r(e.session)&&r(e.text)?{type:"takeDraft",session:e.session,text:e.text}:null;case"takeQueuedDraft":return r(e.session)&&r(e.text)&&Number.isSafeInteger(e.revision)&&e.revision>=0&&r(e.value)?{type:"takeQueuedDraft",session:e.session,text:e.text,revision:e.revision,value:e.value}:null;case"promptRecovery":try{return{type:"promptRecovery",submittedPrompts:xe(e.submittedPrompts)}}catch{return null}case"requestPromptRecovery":return r(e.request)?{type:"requestPromptRecovery",request:e.request}:null;case"restoreDraft":return r(e.session)&&r(e.text)&&typeof e.revision=="number"?{type:"restoreDraft",session:e.session,text:e.text,revision:e.revision}:null;case"notes":return{type:"notes",comments:e.comments};case"openComment":return r(e.key)?{type:"openComment",key:e.key}:null;case"sendSelectedText":return r(e.key)&&e.key.length>0&&typeof e.copyLabels=="boolean"?{type:"sendSelectedText",key:e.key,copyLabels:e.copyLabels}:null;case"setRead":return r(e.key)?{type:"setRead",key:e.key,read:e.read===!0}:null;case"forgetState":return typeof e.since=="number"?{type:"forgetState",since:e.since}:null;case"setSessionRead":return r(e.session)?{type:"setSessionRead",session:e.session,read:e.read===!0}:null;case"setSessionArchived":return r(e.session)?{type:"setSessionArchived",session:e.session,archived:e.archived===!0}:null;case"setSessionPinned":return r(e.session)?{type:"setSessionPinned",session:e.session,pinned:e.pinned===!0}:null;case"setComposerHidden":return{type:"setComposerHidden",hidden:e.hidden===!0};case"results":return r(e.query)&&r(e.scope)?{type:"results",query:e.query,hits:e.hits,scope:e.scope}:null;case"render":{let o=e.sessionAdoptions;return w(e.cards)&&w(e.sessions)&&w(e.rail)&&f(e.stats)!==null&&A(e.hidden)&&A(e.pinnedTop)&&w(e.comments)&&Array.isArray(e.labels)&&e.labels.every(Q)&&z(e.views)&&Y(e.railFilters)&&Array.isArray(e.iconFonts)&&e.iconFonts.every(r)&&Array.isArray(o)&&o.every(Le)?e:null}default:return null}}function Ae(t){let e=f(t);if(!e)return null;switch(e.type){case"health":return Number.isSafeInteger(e.sequence)&&e.sequence>0?{type:"health",sequence:e.sequence}:null;case"ready":return{type:"ready"};case"painted":return Number.isSafeInteger(e.generation)&&e.generation>=0&&(e.stage==="railReady"||e.stage==="firstCard"||e.stage==="completeRender")?{type:"painted",generation:e.generation,stage:e.stage,...e.usableRows===!0?{usableRows:!0}:{}}:null;case"initialize":return{type:"initialize"};case"developmentReload":return{type:"developmentReload"};case"refresh":return{type:"refresh"};case"perf":return wt(e.kind)&&v(e.ms)&&e.ms>=0?{type:"perf",kind:e.kind,ms:e.ms}:null;case"goBack":return{type:"goBack"};case"goForward":return{type:"goForward"};case"newSession":{if(e.owner!==void 0&&!r(e.owner))return null;let o=e.owner===void 0?{}:{owner:e.owner};if(e.request===void 0)return{type:"newSession",...o};let s=Pe(e.request);return s?{type:"newSession",request:s,...o}:null}case"pinSetup":{if(e.owner!==void 0&&!r(e.owner))return null;let o=e.owner===void 0?{}:{owner:e.owner},s=Pe(e.request);if(!s)return null;if(s.kind==="custom")return{type:"pinSetup",request:s,...o};let n=we(f(e.request)?.values);return n?{type:"pinSetup",request:{...s,values:n},...o}:null}case"unpinSetup":return(e.owner===void 0||r(e.owner))&&r(e.id)&&e.id.trim().length>0&&e.id.length<=Se?{type:"unpinSetup",id:e.id,...e.owner===void 0?{}:{owner:e.owner}}:null;case"refreshUsage":return{type:"refreshUsage",agent:r(e.agent)?e.agent:null,force:e.force===!0};case"requestDefaults":return(e.agent==="claude"||e.agent==="codex")&&r(e.model)&&e.model.length<=200?{type:"requestDefaults",agent:e.agent,model:e.model}:null;case"openControl":return r(e.control)&&r(e.session)?{type:"openControl",control:e.control,session:e.session}:null;case"pick":return r(e.agent)&&r(e.value)&&r(e.session)?{type:"pick",control:String(e.control),agent:e.agent,session:e.session,model:h(e.model,""),value:e.value}:null;case"draft":return r(e.text)&&r(e.session)?{type:"draft",text:e.text,keep:h(e.keep,e.text),session:e.session,...Number.isSafeInteger(e.revision)?{revision:e.revision}:{}}:null;case"contextDetail":return S(e.session)&&e.session&&g(e.request)&&g(e.generation)?{type:"contextDetail",session:e.session,request:e.request,generation:e.generation}:null;case"pathCompletion":return r(e.session)&&v(e.request)&&r(e.token)&&v(e.caret)?{type:"pathCompletion",session:e.session,request:e.request,token:e.token,caret:e.caret}:null;case"answerAsk":{if(!r(e.session)||!r(e.id))return null;let o=It(e.answer);return o?{type:"answerAsk",session:e.session,id:e.id,answer:o}:null}case"dropUris":return r(e.session)?{type:"dropUris",session:e.session,...At(e)}:null;case"beginFileStaging":return r(e.session)?{type:"beginFileStaging",session:e.session,token:h(e.token,"")}:null;case"attachFiles":return r(e.session)?{type:"attachFiles",session:e.session,token:h(e.token,""),clipboard:e.clipboard===!0,files:e.files}:null;case"fileReadError":return r(e.session)?{type:"fileReadError",session:e.session,token:h(e.token,""),name:h(e.name,"")}:null;case"fileRejected":return r(e.session)?{type:"fileRejected",session:e.session,code:h(e.code,"read"),name:h(e.name,""),size:Ce(e.size,0),rejected:Ce(e.rejected,0)}:null;case"removeFile":return r(e.session)&&r(e.value)?{type:"removeFile",session:e.session,value:e.value}:null;case"importPromptRecovery":return{type:"importPromptRecovery",submittedPrompts:e.submittedPrompts,...r(e.request)?{request:e.request}:{}};case"sendPrompt":return r(e.text)&&r(e.session)?{type:"sendPrompt",text:e.text,session:e.session,...e.attempt&&typeof e.attempt=="object"?{attempt:e.attempt}:{},revision:typeof e.revision=="number"&&Number.isSafeInteger(e.revision)&&e.revision>=0?e.revision:0}:null;case"compact":return r(e.session)?{type:"compact",session:e.session}:null;case"dismissLive":return r(e.session)?{type:"dismissLive",session:e.session,kind:h(e.kind,"")}:null;case"restoreLive":return r(e.session)?{type:"restoreLive",session:e.session,kind:h(e.kind,"")}:null;case"stopTurn":return r(e.session)?{type:"stopTurn",session:e.session}:null;case"dequeue":return r(e.value)&&r(e.session)?{type:"dequeue",value:e.value,session:e.session}:null;case"editQueued":return r(e.value)&&r(e.session)&&Number.isSafeInteger(e.revision)&&e.revision>=0?{type:"editQueued",value:e.value,session:e.session,revision:e.revision}:null;case"acceptQueuedEdit":return r(e.value)&&r(e.session)&&Number.isSafeInteger(e.revision)&&e.revision>=0&&Number.isSafeInteger(e.currentRevision)&&e.currentRevision>=0&&typeof e.accepted=="boolean"?{type:"acceptQueuedEdit",value:e.value,session:e.session,revision:e.revision,currentRevision:e.currentRevision,accepted:e.accepted}:null;case"copy":return r(e.text)?{type:"copy",text:e.text}:null;case"note":return{type:"note",note:e.note};case"armSelectedText":return r(e.session)&&e.session.length>0&&r(e.key)&&e.key.length>0?{type:"armSelectedText",session:e.session,key:e.key}:null;case"selectedTextHandoff":return r(e.session)&&e.session.length>0&&r(e.key)&&e.key.length>0&&r(e.text)&&e.text.trim().length>0&&typeof e.copyLabels=="boolean"?{type:"selectedTextHandoff",session:e.session,key:e.key,text:e.text,copyLabels:e.copyLabels}:null;case"armSessionDetails":return r(e.session)&&e.session.length>0?{type:"armSessionDetails",session:e.session}:null;case"armComposer":return{type:"armComposer"};case"showReaderParent":return r(e.session)&&e.session.length>0?{type:"showReaderParent",session:e.session}:null;case"showSession":return r(e.session)?{type:"showSession",session:e.session,...e.parent===!0?{parent:!0}:{}}:null;case"labelEditor":return r(e.session)?{type:"labelEditor",session:e.session}:null;case"setLabels":return r(e.session)&&Array.isArray(e.names)?{type:"setLabels",session:e.session,names:e.names.filter(r)}:null;case"setViews":return z(e.views)?{type:"setViews",views:e.views}:null;case"renameSession":return r(e.session)&&e.session.length>0&&Number.isSafeInteger(e.request)&&r(e.title)?{type:"renameSession",session:e.session,request:e.request,title:e.title}:null;case"setRailFilters":return Y(e.railFilters)?{type:"setRailFilters",railFilters:e.railFilters}:null;case"sessionMembership":return r(e.session)?e.action==="pin"?e.openPinned!==void 0&&typeof e.openPinned!="boolean"?null:{type:"sessionMembership",action:e.action,session:e.session,...e.openPinned===!0?{openPinned:!0}:{}}:e.action==="archive"||e.action==="unarchive"||e.action==="unpin"?{type:"sessionMembership",action:e.action,session:e.session}:null:null;case"setLayout":return e.key==="cardLayout"&&W(e.value)?{type:"setLayout",key:"cardLayout",value:e.value}:e.key==="promptPosition"&&K(e.value)?{type:"setLayout",key:"promptPosition",value:e.value}:null;case"exportSession":return r(e.session)&&e.session.length>0?{type:"exportSession",session:e.session}:null;case"saveState":return{type:"saveState",state:e.state};case"search":return{type:"search",text:h(e.text,"")};case"loadOlder":return r(e.session)?{type:"loadOlder",session:e.session,token:h(e.token,"")}:null;case"openLink":return r(e.href)?{type:"openLink",href:e.href,beside:e.beside===!0}:null;case"openVisualization":return r(e.path)?{type:"openVisualization",path:e.path}:null;case"openImage":return r(e.path)?{type:"openImage",path:e.path,beside:e.beside===!0}:null;case"openTurnDiff":return r(e.key)?{type:"openTurnDiff",key:e.key,beside:e.beside===!0}:null;case"openCommit":return r(e.key)&&r(e.sha)?{type:"openCommit",key:e.key,sha:e.sha,dir:r(e.dir)?e.dir:null,beside:e.beside===!0}:null;case"openFile":return r(e.key)&&r(e.path)?{type:"openFile",key:e.key,path:e.path,beside:e.beside===!0,...r(e.sourceSessionId)?{sourceSessionId:e.sourceSessionId}:{}}:null;case"openSkill":return r(e.key)&&r(e.path)?{type:"openSkill",key:e.key,path:e.path,beside:e.beside===!0}:null;default:return null}}var _t={health:"noop",contextDetail:"handled",ready:"handled",painted:"noop",initialize:"noop",developmentReload:"noop",refresh:"noop",perf:"noop",goBack:"handled",goForward:"handled",newSession:"noop",pinSetup:"noop",unpinSetup:"noop",refreshUsage:"noop",openControl:"noop",requestDefaults:"noop",pick:"noop",draft:"noop",pathCompletion:"handled",answerAsk:"noop",beginFileStaging:"noop",attachFiles:"noop",dropUris:"noop",fileReadError:"noop",fileRejected:"noop",removeFile:"noop",sendPrompt:"noop",importPromptRecovery:"handled",compact:"noop",dismissLive:"noop",restoreLive:"noop",stopTurn:"noop",dequeue:"noop",editQueued:"noop",acceptQueuedEdit:"noop",copy:"handled",note:"handled",armSelectedText:"noop",selectedTextHandoff:"noop",armSessionDetails:"noop",armComposer:"noop",showReaderParent:"handled",showSession:"handled",labelEditor:"handled",setLabels:"handled",setViews:"handled",renameSession:"noop",setRailFilters:"handled",sessionMembership:"handled",setLayout:"handled",exportSession:"handled",saveState:"handled",search:"noop",loadOlder:"noop",openLink:"noop",openVisualization:"noop",openImage:"noop",openTurnDiff:"noop",openCommit:"noop",openFile:"noop",openSkill:"noop"};function Nt(t,e,o){let s=e.agent==="codex"?"codex":"claude",n=e.contextTokens,a=e.contextWindow??2e5,i=e.model??"",l=Math.floor(n*.12),c=Math.floor(n*.35),m=Math.floor(n*.38),p=[{key:"instructions",name:"Instructions",tokens:l,relationship:"used"},{key:"messages",name:"Messages",tokens:c,relationship:"used"},{key:"tools",name:"Tool results",tokens:m,relationship:"used"},{key:"other",name:s==="codex"?"Unattributed context":"Tool definitions",tokens:n-l-c-m,relationship:"used"}],d=s==="codex"?{kind:"codex-retained-context",basis:"request",session:t.session,model:i,used:n,capacity:a,categories:p}:{model:i,totalTokens:n,rawMaxTokens:a,categories:[...p.map(b=>({name:b.name,tokens:b.tokens,kind:"used"})),{name:"Free space",tokens:Math.max(0,a-n-Math.floor(a*.1)),kind:"free"},{name:"Compaction buffer",tokens:Math.floor(a*.1),kind:"buffer"}]},u=be(d,{...t,provider:s,model:i,source:"demo"},o);if(!M(u)||u.status!=="available")throw new Error("Invalid demo context detail");return{type:"contextDetail",detail:u}}var Ie={policy:_t,parsePanelToHost:Ae,parseHostToPanel:Me,contextReply:Nt};window.__ARC_DEMO_SAMPLES__.host=Ie;window.__ARC_DEMO_SAMPLES__.labelRules={labelCounts:V,labelEditorReply:oe,labelsOf:$,railLabelFields:re,setSessionLabels:ne};window.__ARC_DEMO_SAMPLES__.readRules={newBySession:ie};window.__ARC_DEMO_SAMPLES__.commentRules={applyComment:ue,normalizeComments:L};window.__ARC_DEMO_SAMPLES__.placeRules={emptyTrail:ce,visitPlace:pe,stepBack:de,stepForward:me,trailPlace:U};window.__ARC_DEMO_SAMPLES__.isSendChord=fe;window.__ARC_DEMO_SAMPLES__.navigationShortcut=ge;window.__ARC_DEMO_SAMPLES__.installMenu=ye;})();
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
