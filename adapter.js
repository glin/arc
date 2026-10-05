(()=>{function I(t,e,o){if(t.length<=e)return t;let s=t.slice(0,Math.max(0,e-o.length)),r=s.charCodeAt(s.length-1);return r>=55296&&r<=56319&&(s=s.slice(0,-1)),s+o}var Te=/[\p{Cc}\p{Cf}\p{Cs}]/gu,Le=/[\u200c\u200d\u{e0020}-\u{e007f}]/u,Pe=/\u200d+$/u,Ce=/[^\p{White_Space}\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]/u;function N(t,e){if(typeof t!="string")return"";let r=t.normalize("NFC").replace(/\p{White_Space}+/gu," ").replace(Te,i=>Le.test(i)?i:"").normalize("NFC").trim(),a=I(r,e,"").replace(Pe,"").trim();return Ce.test(a)?a:""}function S(t){return t.toLocaleLowerCase()}function F(t){return t===1?"carried by one session":`carried by ${t} sessions`}var Me=20,Ae=500,_e=2;function V(t){return N(t,40)}function Z(t,e){let o=[],s=new Set;for(let r of t){let a=V(r);if(!a)continue;let i=S(a),u=e.get(i);if(u===void 0&&e.set(i,a),!s.has(i)&&(s.add(i),o.push(u??a),o.length===Me))break}return o}function H(t,e){let o=Object.prototype.hasOwnProperty.call(t,e)?t[e]:null;return Array.isArray(o)?[...o]:[]}function te(t,e,o){let s=!!e&&e!=="__proto__"&&Z(o,new Map).length>0,r=[];for(let[c,m]of Object.entries(t))c!==e&&c!=="__proto__"&&r.push([c,m]);let a=Ae-(s?1:0),i=new Map,u={};for(let[c,m]of r.slice(Math.max(0,r.length-Math.max(0,a)))){u[c]=[...m];for(let p of m){let d=S(p);i.has(d)||i.set(d,p)}}return s&&(u[e]=Z(o,i)),u}function Ie(t){let e=t.slice(0,_e),o=t.slice(e.length);return{chips:e,more:o.length?`+${o.length}`:null,rest:o}}function ne(t,e){let{chips:o,more:s,rest:r}=Ie(t);return{labels:[...t],labelChips:o,labelsMore:s,labelsMoreName:r.length?r.join(", "):null,labelClause:t.length?`${e} ${t.join(", ")}`:null}}function $(t){let e=new Map;for(let[o,s]of Object.entries(t)){if(!o||o==="__proto__"||!Array.isArray(s))continue;let r=new Set;for(let a of s){let i=V(a);if(!i)continue;let u=S(i);if(r.has(u))continue;r.add(u);let c=e.get(u);c?c.count+=1:e.set(u,{name:i,count:1})}}return[...e.values()].sort((o,s)=>s.count-o.count||o.name.localeCompare(s.name)).map(o=>({...o,countName:F(o.count)}))}function Ne(t,e){let o=$(t),s=new Map(o.map(i=>[S(i.name),i])),r=new Set,a=[];for(let i of H(t,e)){let u=V(i);if(!u)continue;let c=S(u),m=s.get(c);!m||r.has(c)||(r.add(c),a.push({...m,applied:!0}))}for(let i of o)r.has(S(i.name))||a.push({...i,applied:!1});return a}function re(t,e,o,s,r=o){let a=e.find(i=>i.id===o)?.label??o;return{type:"labelEditor",session:r,heading:`${s} ${a}`,rows:Ne(t,o)}}function oe(t,e,o,s=0){if(e.has(t.key))return!0;let r=o.get(t.sessionId)??s;return r>0&&t.startedAt<=r}function se(t,e,o,s=0){let r=new Set(e),a=new Map;for(let u of t){if(u.kind!=="turn"||!oe(u,r,o,s))continue;let c=a.get(u.sessionId);(c===void 0||u.startedAt>c)&&a.set(u.sessionId,u.startedAt)}let i=new Map;for(let u of t){if(u.kind!=="turn"||(i.has(u.sessionId)||i.set(u.sessionId,0),oe(u,r,o,s)))continue;let c=a.get(u.sessionId);c!==void 0&&u.startedAt<=c||i.set(u.sessionId,i.get(u.sessionId)+1)}return i}var q="…";function ie(t){return!!t&&/^\S{1,200}$/.test(t)}var Fe=200,ae=6e3,C=2e3,Ve=/^answer:\d{1,4}$/,He=/^prompt:\d{1,4}$/;function $e(t){return t==="prompt"||t==="summary"||typeof t=="string"&&Ve.test(t)||typeof t=="string"&&He.test(t)||typeof t=="string"&&t.startsWith("said:")&&ie(t.slice(5))?t:"summary"}function qe(t){if(!t||typeof t!="object"||Array.isArray(t))return null;let e=t,o=(p,d)=>typeof p=="string"?I(p,d,q):"",s=p=>typeof p=="number"&&Number.isFinite(p)?p:null,r=o(e.id,C),a=o(e.sessionId,C),i=o(e.turnKey,C),u=o(e.note,ae).trim(),c=s(e.at),m=s(e.turnAt);return!r||!a||!i||!u||c===null||m===null?null:{id:r,sessionId:a,turnKey:i,part:$e(e.part),quote:o(e.quote,ae),offset:typeof e.offset=="number"&&Number.isFinite(e.offset)&&e.offset>=0?Math.trunc(e.offset):void 0,note:u,headline:o(e.headline,C),sessionTitle:o(e.sessionTitle,C),turnAt:m,at:c}}function P(t){let e=[];if(Array.isArray(t))for(let o of t){let s=qe(o);s&&e.push(s)}return e.slice(Math.max(0,e.length-Fe))}function ue(t,e){if(!e||typeof e!="object")return[...t];let o=e;if(o.op==="clear"){let i=typeof o.sessionId=="string"?o.sessionId:"";return i?P(t.filter(u=>u.sessionId!==i)):[...t]}if(o.op==="delete"){let i=typeof o.id=="string"?o.id:"";return i?P(t.filter(u=>u.id!==i)):[...t]}if(o.op!=="write")return[...t];let[s]=P([o.note]);if(!s)return[...t];let r=t.findIndex(i=>i.id===s.id),a=[...t];return r<0?a.push(s):a[r]=s,P(a)}function je(t){return/^Mac/.test(t||"")}function le(t,e){return!t||t.key!=="Enter"||t.altKey||t.shiftKey?!1:je(e)?!!t.metaKey&&!t.ctrlKey:!!t.ctrlKey&&!t.metaKey}function Ue(t,e){if(!t.trim())return!0;let o=l=>{throw new Error(`The menu stand-in cannot read the when clause "${t}": ${l}.`)},s=[],r=/\s*('[^']*'|==|!=|&&|\|\||[!()]|[A-Za-z_][\w.:-]*)/y;for(;r.lastIndex<t.length&&t.slice(r.lastIndex).trim();){let l=r.lastIndex,b=r.exec(t);b||o(`unsupported text at "${t.slice(l).trim()}"`),s.push(b[1])}let a=l=>l!==void 0&&/^[A-Za-z_]/.test(l),i=0,u=l=>l?.startsWith("'")?l.slice(1,-1):(a(l)||o(`a comparison has no value after "${s[i-2]} ${s[i-1]}"`),l==="true"?!0:l==="false"?!1:l),c=()=>{let l=s[i++];if(l==="("){let v=p();return s[i++]!==")"&&o("a parenthesis is not closed"),v}if(l==="!")return!c();a(l)||o(l===void 0?"it ends early":`unexpected "${l}"`);let b=e[l];if(s[i]==="=="||s[i]==="!="){let v=s[i++]==="==",T=u(s[i++]);return(b===T||String(b)===String(T))===v}return!!b},m=()=>{let l=c();for(;s[i]==="&&";)i++,l=c()&&l;return l},p=()=>{let l=m();for(;s[i]==="||";)i++,l=m()||l;return l},d=p();return i<s.length&&o(`unexpected "${s[i]}"`),d}function We(t,e){let o=new Map;for(let s of t){if(!Ue(s.when,e))continue;let[r,a]=s.group.split("@"),i=o.get(r)??[];i.push({order:Number(a)||0,entry:s}),o.set(r,i)}return[...o.keys()].sort((s,r)=>s==="navigation"?-1:r==="navigation"?1:s<r?-1:s>r?1:0).map(s=>o.get(s).sort((r,a)=>r.order-a.order).map(r=>r.entry))}function Be(t){let e=[];for(let o=t;o;o=o.parentElement){let s=o.dataset?.vscodeContext;if(s)try{e.push(JSON.parse(s))}catch{}}return Object.assign({},...e.reverse())}function ce(t,e,o){let s=t.defaultView,r=null;s.addEventListener("contextmenu",a=>{let i=a.target instanceof Element?a.target:null;if(!i||i.closest(".demo-menu"))return;r?.(!1);let u=Be(i),c=We(e,u);if(!c.length)return;a.preventDefault();let m=t.activeElement instanceof HTMLElement?t.activeElement:null,p=t.createElement("div");p.className="demo-menu",p.setAttribute("role","menu"),c.forEach((y,_)=>{if(_){let k=t.createElement("div");k.setAttribute("role","separator"),p.append(k)}for(let k of y){let L=t.createElement("button");L.type="button",L.setAttribute("role","menuitem"),L.tabIndex=-1,L.textContent=k.title,L.addEventListener("click",()=>{r?.(!0),o(k.command,u)}),p.append(L)}}),t.body.append(p);let d=Array.from(p.querySelectorAll('[role="menuitem"]')),l=i.getBoundingClientRect(),b=a.clientX===0&&a.clientY===0,v=b?l.left:a.clientX,T=b?l.bottom:a.clientY,Y=p.offsetWidth,G=p.offsetHeight;p.style.left=`${Math.max(0,v+Y>s.innerWidth?s.innerWidth-Y:v)}px`,p.style.top=`${Math.max(0,T+G>s.innerHeight?T-G:T)}px`;let X=y=>{(!(y.target instanceof Node)||!p.contains(y.target))&&r?.(!1)},O=y=>{p.remove(),t.removeEventListener("pointerdown",X,!0),s.removeEventListener("blur",J),r=null,y&&m?.isConnected&&m.focus()},J=()=>O(!1);r=O,t.addEventListener("pointerdown",X,!0),s.addEventListener("blur",J),p.addEventListener("keydown",y=>{let _=d.indexOf(t.activeElement),k=y.key==="ArrowDown"?(_+1)%d.length:y.key==="ArrowUp"?(_-1+d.length)%d.length:y.key==="Home"?0:y.key==="End"?d.length-1:-1;k>=0?(y.preventDefault(),d[k].focus()):(y.key==="Escape"||y.key==="Tab")&&(y.preventDefault(),O(!0))}),d[0].focus()})}function x(t){return typeof t=="string"&&t.length<=256*2&&Array.from(t).length<=256}function g(t){return typeof t=="number"&&Number.isSafeInteger(t)&&t>=0}function E(t){if(!t||typeof t!="object")return!1;let e=t;return x(e.session)&&!!e.session&&x(e.model)&&x(e.source)&&(e.provider==="claude"||e.provider==="codex")&&g(e.generation)&&g(e.request)}function D(t,e="unavailable"){return{...t,status:e,capturedAt:Date.now(),measurement:"provider-estimate",used:null,capacity:null,remaining:null,reserve:null,categories:[]}}function pe(t,e,o=Date.now()){if(e.provider==="codex")return Qe(t,e,o);let s=D(e);if(!E(e)||e.provider!=="claude"||!t||typeof t!="object")return s;let r=t;if(!g(r.totalTokens)||!g(r.rawMaxTokens)||r.rawMaxTokens===0||!x(r.model)||!Array.isArray(r.categories)||r.categories.length>32)return s;let a=[],i=new Set,u=null,c=null;for(let p of r.categories){if(!p||typeof p!="object")return s;let d=p;if(!x(d.name)||!d.name.trim()||!g(d.tokens)||typeof d.kind!="string"||!["used","free","buffer","deferred"].includes(d.kind))return s;let l=d.name;if(i.has(l))return s;i.add(l),d.kind==="used"&&a.push({key:l,name:d.name,tokens:d.tokens,relationship:"used"}),d.kind==="free"&&(u=(u??0)+d.tokens),d.kind==="buffer"&&(c=(c??0)+d.tokens)}let m=a.reduce((p,d)=>p+d.tokens,0);return!g(m)||u!==null&&!g(u)||c!==null&&!g(c)?s:(a.sort((p,d)=>d.tokens-p.tokens),{...e,model:r.model,capturedAt:o,measurement:"provider-estimate",status:m===r.totalTokens?"available":"mismatch",used:r.totalTokens,capacity:r.rawMaxTokens,remaining:u,reserve:c,categories:a})}function Qe(t,e,o){let s=D(e);if(!E(e)||!t||typeof t!="object")return s;let r=t;if(r.kind!=="codex-retained-context"||!["request","retained-estimate"].includes(String(r.basis))||r.session!==e.session||!x(r.model)||!r.model||e.model&&r.model!==e.model||!g(r.used)||!g(r.capacity)||!r.capacity||!Array.isArray(r.categories)||!r.categories.length||r.categories.length>32)return s;let a={...e,model:r.model,capturedAt:o,measurement:"local-estimate",basis:r.basis,status:r.categories.reduce((i,u)=>i+(u?.tokens??NaN),0)===r.used?"available":"mismatch",used:r.used,capacity:r.capacity,remaining:Math.max(0,r.capacity-r.used),reserve:null,categories:r.categories.map(i=>({key:i?.key,name:i?.name,tokens:i?.tokens,relationship:i?.relationship}))};return M(a)?(a.categories.sort((i,u)=>u.tokens-i.tokens),a):s}function M(t){if(!E(t))return!1;let e=t;if(!["loading","available","mismatch","unavailable","stale"].includes(e.status)||!g(e.capturedAt)||!["provider-estimate","local-estimate"].includes(e.measurement)||e.measurement==="local-estimate"&&(e.provider!=="codex"||e.reserve!==null)||e.measurement==="local-estimate"&&!["request","retained-estimate"].includes(String(e.basis))||![e.used,e.capacity,e.remaining,e.reserve].every(a=>a===null||g(a))||!Array.isArray(e.categories)||e.categories.length>32)return!1;let o=new Set;for(let a of e.categories){if(!a||!x(a.key)||!x(a.name)||!a.name.trim()||!g(a.tokens)||a.relationship!=="used"||o.has(a.key))return!1;o.add(a.key)}let s=e.status==="available"||e.status==="mismatch",r=e.categories.reduce((a,i)=>a+i.tokens,0);return s&&(e.used===null||!e.capacity||!g(r)||e.status==="available"!=(r===e.used))||!s&&(e.categories.length||e.used!==null||e.capacity!==null)?!1:new TextEncoder().encode(JSON.stringify({type:"contextDetail",detail:e})).length<=32768}function de(...t){let e=new Map;for(let o of t)if(Array.isArray(o))for(let s of o){if(!s||typeof s!="object")continue;let r=s;if(typeof r.id!="string"||!r.id||r.id.length>200||typeof r.source!="string"||r.source.length>200||typeof r.text!="string"||r.text.length>2e4||!Number.isSafeInteger(r.order)||r.order<1||!Number.isSafeInteger(r.revision)||r.revision<0)continue;let a={id:r.id,order:r.order,source:r.source,revision:r.revision,text:r.text};typeof r.owner=="string"&&r.owner.length<=200&&Number.isSafeInteger(r.ownerRevision)&&r.ownerRevision>0&&(a.owner=r.owner,a.ownerRevision=r.ownerRevision,r.accepted===!0&&(a.accepted=!0)),r.setup&&(r.setup.agent==="claude"||r.setup.agent==="codex")&&["model","effort","permissionMode"].every(u=>typeof r.setup[u]=="string"&&r.setup[u].length<=200)&&(a.setup={agent:r.setup.agent,model:r.setup.model,effort:r.setup.effort,permissionMode:r.setup.permissionMode,source:r.setup.source==="inherited"||r.setup.source==="recent"?r.setup.source:"custom"});let i=e.get(r.id);if(i&&(i.order!==a.order||i.source!==a.source||i.revision!==a.revision||i.text!==a.text||i.setup&&a.setup&&["agent","model","effort","permissionMode","source"].some(u=>i.setup[u]!==a.setup[u])))throw new Error("The saved prompt conflicts with another copy.");(!i||(a.ownerRevision??0)>(i.ownerRevision??0))&&e.set(r.id,a)}return[...e.values()].sort((o,s)=>o.order-s.order||(o.id<s.id?-1:o.id>s.id?1:0)).slice(-5)}var Ke=["claude","codex"];function j(t){return typeof t=="string"&&t.length<=200?t:null}function me(t){if(!t||typeof t!="object")return null;let e=t,o=Ke.find(i=>i===e.agent),s=j(e.model),r=j(e.effort),a=j(e.permissionMode);return!o||s===null||r===null||a===null?null:{agent:o,model:s,effort:r,permissionMode:a}}var fe=["latest","cost-desc","cost-asc","needs-you"];var ge=40,ye=200,fn={taken:"A view already has that name. Choose another name.",unnamed:"A view needs a name. Type one to save it.",limit:`A name is cut to ${ge} characters. Two names that agree that far are one view.`};var Ye=ye;var Ge="needs-you",Xe="is:needsyou -is:archived -is:agentrun",Je=["All sessions","Running","Active","Unread","Needs input","Needs you","Custom"],Tn=new Set(Je.map(t=>tt(t))),he=["running","active","unread","input"],Ze={running:"is:running -is:archived -is:agentrun",active:"is:active -is:archived -is:agentrun",unread:"is:unread -is:archived -is:agentrun",input:"is:input -is:archived -is:agentrun"};var Ln=Ye+Math.max(Xe.length,...he.map(t=>Ze[t].length))+1;function et(t){return he.includes(t)}function be(t){return et(t)||t===Ge}function tt(t){return t.toLocaleLowerCase()}var nt=["compact","one-column","two-columns"],rt=["above","below"];function U(t){return typeof t=="string"&&nt.includes(t)}function W(t){return typeof t=="string"&&rt.includes(t)}var st={visibility:!0,startupProgress:!0,contextDetail:!0,focusProjectSpend:!0,openLauncher:!0,labelEditor:!0,labelsChanged:!0,openLabelEditor:!0,showSessionDetails:!0,openViewEditor:!0,openSessionRename:!0,sessionRenameResult:!0,focusComposer:!0,pathCompletion:!0,fileStaging:!0,fileStagingRejected:!0,usage:!0,askRejected:!0,projectSpend:!0,layout:!0,live:!0,activity:!0,selection:!0,rail:!0,openPick:!0,takeDraft:!0,takeQueuedDraft:!0,promptRecovery:!0,requestPromptRecovery:!0,restoreDraft:!0,notes:!0,openComment:!0,sendSelectedText:!0,setRead:!0,forgetState:!0,setSessionRead:!0,setSessionArchived:!0,setSessionPinned:!0,setComposerHidden:!0,results:!0,render:!0};function f(t){return t!==null&&typeof t=="object"&&!Array.isArray(t)?t:null}function n(t){return typeof t=="string"}function w(t){return typeof t=="number"&&Number.isFinite(t)}function it(t){return n(t)&&Object.prototype.hasOwnProperty.call(st,t)}function B(t){return t===void 0||n(t)}function R(t){return Array.isArray(t)&&t.every(e=>f(e)!==null)}function A(t){return Array.isArray(t)&&t.every(n)}function Q(t){let e=f(t);return!!e&&n(e.name)&&w(e.count)&&n(e.countName)}function at(t){let e=f(t);return Q(t)&&typeof e?.applied=="boolean"}function ut(t){let e=f(t);return!!e&&n(e.id)&&e.id!==""&&n(e.name)&&n(e.query)&&typeof e.archived=="boolean"}function K(t){return Array.isArray(t)&&t.every(ut)}function lt(t){let e=f(t);return!!e&&n(e.id)&&e.id!==""&&n(e.name)&&n(e.query)&&fe.includes(e.sort)&&(e.lens===void 0||e.lens===null||be(e.lens))}function z(t){return Array.isArray(t)&&t.every(lt)}function Se(t){let e=f(t);return!!e&&n(e.provisional)&&n(e.durable)}function ct(t){let e=f(t);return!!e&&n(e.id)&&n(e.label)&&n(e.name)&&w(e.size)&&(e.preview===null||n(e.preview))&&n(e.kind)&&n(e.stem)&&n(e.ext)&&n(e.sizeLabel)&&B(e.removeLabel)&&B(e.removeName)&&B(e.removeControl)}function pt(t){let e=f(t);return!!e&&n(e.name)&&typeof e.directory=="boolean"&&n(e.label)&&n(e.accessibleName)&&n(e.completion)}function dt(t){let e=f(t);return!!e&&(e.kind==="prompt"||e.kind==="compact")&&(e.state==="sent"||e.state==="running"||e.state==="failed"||e.state==="done"||e.state==="interrupted")&&(e.tone==="running"||e.tone==="failed"||e.tone==="done"||e.tone==="interrupted")&&n(e.relative)&&n(e.absolute)&&n(e.agent)&&n(e.model)&&n(e.label)&&n(e.headline)&&n(e.status)&&n(e.reply)&&w(e.at)&&(e.since===null||w(e.since))&&n(e.dismissLabel)&&n(e.dismissName)&&n(e.dismissControl)&&n(e.restoreLabel)&&n(e.restoreName)&&n(e.restoreControl)&&n(e.reason)&&Array.isArray(e.files)&&e.files.every(ct)}function h(t,e){return typeof t=="string"?t:e}function xe(t,e){return typeof t=="number"&&Number.isFinite(t)?t:e}function we(t){let e=f(t);return e?e.kind==="row"&&n(e.key)?{kind:"row",key:e.key}:e.kind==="custom"&&n(e.agent)&&n(e.model)&&n(e.effort)&&n(e.permissionMode)?{kind:"custom",agent:e.agent,model:e.model,effort:e.effort,permissionMode:e.permissionMode}:null:null}function mt(t){let e=f(t);if(!e)return null;if(e.decision==="allow")return{decision:"allow"};if(e.decision==="deny"&&n(e.reason))return{decision:"deny",reason:e.reason};if(e.decision==="answer"){let o=f(e.answers);if(!o)return null;let s={};for(let[r,a]of Object.entries(o)){let i=f(a);if(!i||!Array.isArray(i.labels)||!i.labels.every(n)||!n(i.written))return null;s[r]={labels:[...i.labels],written:i.written}}return{decision:"answer",answers:s}}return null}function ke(t){let e=f(t);if(!e)return null;switch(e.type){case"visibility":return typeof e.visible=="boolean"&&Number.isSafeInteger(e.revision)&&e.revision>=0?{type:"visibility",visible:e.visible,revision:e.revision}:null;case"startupProgress":return Number.isSafeInteger(e.generation)&&Number.isSafeInteger(e.sequence)&&n(e.epoch)&&Number.isSafeInteger(e.completed)&&Number.isSafeInteger(e.known)&&e.generation>=0&&e.sequence>=0&&e.completed>=0&&e.known>=e.completed?e:null;case"focusProjectSpend":return{type:"focusProjectSpend"};case"openLauncher":return{type:"openLauncher",custom:e.custom===!0};case"labelEditor":return n(e.session)&&n(e.heading)&&Array.isArray(e.rows)&&e.rows.every(at)?{type:"labelEditor",session:e.session,heading:e.heading,rows:e.rows}:null;case"labelsChanged":return n(e.session)?{type:"labelsChanged",session:e.session}:null;case"openLabelEditor":return n(e.session)?{type:"openLabelEditor",session:e.session}:null;case"showSessionDetails":return n(e.session)&&e.session.length>0?{type:"showSessionDetails",session:e.session}:null;case"openViewEditor":return n(e.view)&&(e.mode==="rename"||e.mode==="delete")?{type:"openViewEditor",view:e.view,mode:e.mode}:null;case"openSessionRename":return n(e.session)&&e.session.length>0&&n(e.title)?{type:"openSessionRename",session:e.session,title:e.title}:null;case"sessionRenameResult":return n(e.session)&&e.session.length>0&&Number.isSafeInteger(e.request)&&n(e.title)&&n(e.error)?{type:"sessionRenameResult",session:e.session,request:e.request,title:e.title,error:e.error}:null;case"focusComposer":return n(e.session)?{type:"focusComposer",session:e.session}:null;case"contextDetail":return M(e.detail)?{type:"contextDetail",detail:e.detail}:E(e.detail)?{type:"contextDetail",detail:D({session:e.detail.session,provider:e.detail.provider,model:e.detail.model,source:e.detail.source,generation:e.detail.generation,request:e.detail.request})}:null;case"pathCompletion":return n(e.session)&&w(e.request)&&n(e.token)&&w(e.caret)&&Array.isArray(e.rows)&&e.rows.every(pt)?{type:"pathCompletion",session:e.session,request:e.request,token:e.token,caret:e.caret,rows:e.rows}:null;case"fileStaging":return n(e.session)?{type:"fileStaging",session:e.session,token:h(e.token,""),pending:e.pending===!0}:null;case"fileStagingRejected":return n(e.session)&&n(e.token)?{type:"fileStagingRejected",session:e.session,token:e.token}:null;case"usage":return{type:"usage",usage:e.usage};case"askRejected":return n(e.session)&&n(e.id)?{type:"askRejected",session:e.session,id:e.id}:null;case"projectSpend":return{type:"projectSpend",projectSpend:e.projectSpend};case"layout":{let o=f(e.layout);return o&&U(o.cardLayout)&&W(o.promptPosition)?{type:"layout",layout:{cardLayout:o.cardLayout,promptPosition:o.promptPosition}}:null}case"live":return n(e.session)&&Array.isArray(e.live)&&e.live.every(dt)?{type:"live",session:e.session,live:e.live}:null;case"activity":return n(e.session)?{type:"activity",session:e.session,card:e.card}:null;case"selection":return R(e.cards)&&R(e.sessions)&&R(e.rail)&&f(e.stats)!==null&&A(e.replaces)?e:null;case"rail":{let o=f(e.stats),s=e.sessionAdoptions===void 0?[]:e.sessionAdoptions;return R(e.rail)&&o!==null&&Array.isArray(e.labels)&&e.labels.every(Q)&&K(e.views)&&z(e.railFilters)&&Array.isArray(s)&&s.every(Se)&&A(e.hidden)&&A(e.pinnedTop)?{type:"rail",rail:e.rail,stats:o,labels:e.labels,views:e.views,railFilters:e.railFilters,sessionAdoptions:s,hidden:e.hidden,pinnedTop:e.pinnedTop}:null}case"openPick":return n(e.control)?{type:"openPick",control:e.control}:null;case"takeDraft":return n(e.session)&&n(e.text)?{type:"takeDraft",session:e.session,text:e.text}:null;case"takeQueuedDraft":return n(e.session)&&n(e.text)&&Number.isSafeInteger(e.revision)&&e.revision>=0&&n(e.value)?{type:"takeQueuedDraft",session:e.session,text:e.text,revision:e.revision,value:e.value}:null;case"promptRecovery":try{return{type:"promptRecovery",submittedPrompts:de(e.submittedPrompts)}}catch{return null}case"requestPromptRecovery":return n(e.request)?{type:"requestPromptRecovery",request:e.request}:null;case"restoreDraft":return n(e.session)&&n(e.text)&&typeof e.revision=="number"?{type:"restoreDraft",session:e.session,text:e.text,revision:e.revision}:null;case"notes":return{type:"notes",comments:e.comments};case"openComment":return n(e.key)?{type:"openComment",key:e.key}:null;case"sendSelectedText":return n(e.key)&&e.key.length>0&&typeof e.copyLabels=="boolean"?{type:"sendSelectedText",key:e.key,copyLabels:e.copyLabels}:null;case"setRead":return n(e.key)?{type:"setRead",key:e.key,read:e.read===!0}:null;case"forgetState":return typeof e.since=="number"?{type:"forgetState",since:e.since}:null;case"setSessionRead":return n(e.session)?{type:"setSessionRead",session:e.session,read:e.read===!0}:null;case"setSessionArchived":return n(e.session)?{type:"setSessionArchived",session:e.session,archived:e.archived===!0}:null;case"setSessionPinned":return n(e.session)?{type:"setSessionPinned",session:e.session,pinned:e.pinned===!0}:null;case"setComposerHidden":return{type:"setComposerHidden",hidden:e.hidden===!0};case"results":return n(e.query)&&n(e.scope)?{type:"results",query:e.query,hits:e.hits,scope:e.scope}:null;case"render":{let o=e.sessionAdoptions;return R(e.cards)&&R(e.sessions)&&R(e.rail)&&f(e.stats)!==null&&A(e.hidden)&&A(e.pinnedTop)&&R(e.comments)&&Array.isArray(e.labels)&&e.labels.every(Q)&&K(e.views)&&z(e.railFilters)&&Array.isArray(e.iconFonts)&&e.iconFonts.every(n)&&Array.isArray(o)&&o.every(Se)?e:null}default:return null}}function Re(t){let e=f(t);if(!e)return null;switch(e.type){case"ready":return{type:"ready"};case"painted":return Number.isSafeInteger(e.generation)&&e.generation>=0&&(e.stage==="railReady"||e.stage==="firstCard"||e.stage==="completeRender")?{type:"painted",generation:e.generation,stage:e.stage,...e.usableRows===!0?{usableRows:!0}:{}}:null;case"initialize":return{type:"initialize"};case"developmentReload":return{type:"developmentReload"};case"refresh":return{type:"refresh"};case"perf":return it(e.kind)&&w(e.ms)&&e.ms>=0?{type:"perf",kind:e.kind,ms:e.ms}:null;case"goBack":return{type:"goBack"};case"goForward":return{type:"goForward"};case"newSession":{if(e.owner!==void 0&&!n(e.owner))return null;let o=e.owner===void 0?{}:{owner:e.owner};if(e.request===void 0)return{type:"newSession",...o};let s=we(e.request);return s?{type:"newSession",request:s,...o}:null}case"pinSetup":{if(e.owner!==void 0&&!n(e.owner))return null;let o=e.owner===void 0?{}:{owner:e.owner},s=we(e.request);if(!s)return null;if(s.kind==="custom")return{type:"pinSetup",request:s,...o};let r=me(f(e.request)?.values);return r?{type:"pinSetup",request:{...s,values:r},...o}:null}case"unpinSetup":return(e.owner===void 0||n(e.owner))&&n(e.id)&&e.id.trim().length>0&&e.id.length<=64?{type:"unpinSetup",id:e.id,...e.owner===void 0?{}:{owner:e.owner}}:null;case"refreshUsage":return{type:"refreshUsage",agent:n(e.agent)?e.agent:null,force:e.force===!0};case"requestDefaults":return(e.agent==="claude"||e.agent==="codex")&&n(e.model)&&e.model.length<=200?{type:"requestDefaults",agent:e.agent,model:e.model}:null;case"openControl":return n(e.control)&&n(e.session)?{type:"openControl",control:e.control,session:e.session}:null;case"pick":return n(e.agent)&&n(e.value)&&n(e.session)?{type:"pick",control:String(e.control),agent:e.agent,session:e.session,model:h(e.model,""),value:e.value}:null;case"draft":return n(e.text)&&n(e.session)?{type:"draft",text:e.text,keep:h(e.keep,e.text),session:e.session,...Number.isSafeInteger(e.revision)?{revision:e.revision}:{}}:null;case"contextDetail":return x(e.session)&&e.session&&g(e.request)&&g(e.generation)?{type:"contextDetail",session:e.session,request:e.request,generation:e.generation}:null;case"pathCompletion":return n(e.session)&&w(e.request)&&n(e.token)&&w(e.caret)?{type:"pathCompletion",session:e.session,request:e.request,token:e.token,caret:e.caret}:null;case"answerAsk":{if(!n(e.session)||!n(e.id))return null;let o=mt(e.answer);return o?{type:"answerAsk",session:e.session,id:e.id,answer:o}:null}case"beginFileStaging":return n(e.session)?{type:"beginFileStaging",session:e.session,token:h(e.token,"")}:null;case"attachFiles":return n(e.session)?{type:"attachFiles",session:e.session,token:h(e.token,""),clipboard:e.clipboard===!0,files:e.files}:null;case"fileReadError":return n(e.session)?{type:"fileReadError",session:e.session,token:h(e.token,""),name:h(e.name,"")}:null;case"fileRejected":return n(e.session)?{type:"fileRejected",session:e.session,code:h(e.code,"read"),name:h(e.name,""),size:xe(e.size,0),rejected:xe(e.rejected,0)}:null;case"removeFile":return n(e.session)&&n(e.value)?{type:"removeFile",session:e.session,value:e.value}:null;case"importPromptRecovery":return{type:"importPromptRecovery",submittedPrompts:e.submittedPrompts,...n(e.request)?{request:e.request}:{}};case"sendPrompt":return n(e.text)&&n(e.session)?{type:"sendPrompt",text:e.text,session:e.session,...e.attempt&&typeof e.attempt=="object"?{attempt:e.attempt}:{},revision:typeof e.revision=="number"&&Number.isSafeInteger(e.revision)&&e.revision>=0?e.revision:0}:null;case"compact":return n(e.session)?{type:"compact",session:e.session}:null;case"dismissLive":return n(e.session)?{type:"dismissLive",session:e.session,kind:h(e.kind,"")}:null;case"restoreLive":return n(e.session)?{type:"restoreLive",session:e.session,kind:h(e.kind,"")}:null;case"stopTurn":return n(e.session)?{type:"stopTurn",session:e.session}:null;case"dequeue":return n(e.value)&&n(e.session)?{type:"dequeue",value:e.value,session:e.session}:null;case"editQueued":return n(e.value)&&n(e.session)&&Number.isSafeInteger(e.revision)&&e.revision>=0?{type:"editQueued",value:e.value,session:e.session,revision:e.revision}:null;case"acceptQueuedEdit":return n(e.value)&&n(e.session)&&Number.isSafeInteger(e.revision)&&e.revision>=0&&Number.isSafeInteger(e.currentRevision)&&e.currentRevision>=0&&typeof e.accepted=="boolean"?{type:"acceptQueuedEdit",value:e.value,session:e.session,revision:e.revision,currentRevision:e.currentRevision,accepted:e.accepted}:null;case"copy":return n(e.text)?{type:"copy",text:e.text}:null;case"note":return{type:"note",note:e.note};case"armSelectedText":return n(e.session)&&e.session.length>0&&n(e.key)&&e.key.length>0?{type:"armSelectedText",session:e.session,key:e.key}:null;case"selectedTextHandoff":return n(e.session)&&e.session.length>0&&n(e.key)&&e.key.length>0&&n(e.text)&&e.text.trim().length>0&&typeof e.copyLabels=="boolean"?{type:"selectedTextHandoff",session:e.session,key:e.key,text:e.text,copyLabels:e.copyLabels}:null;case"armSessionDetails":return n(e.session)&&e.session.length>0?{type:"armSessionDetails",session:e.session}:null;case"armComposer":return{type:"armComposer"};case"showReaderParent":return n(e.session)&&e.session.length>0?{type:"showReaderParent",session:e.session}:null;case"showSession":return n(e.session)?{type:"showSession",session:e.session}:null;case"labelEditor":return n(e.session)?{type:"labelEditor",session:e.session}:null;case"setLabels":return n(e.session)&&Array.isArray(e.names)?{type:"setLabels",session:e.session,names:e.names.filter(n)}:null;case"setViews":return K(e.views)?{type:"setViews",views:e.views}:null;case"renameSession":return n(e.session)&&e.session.length>0&&Number.isSafeInteger(e.request)&&n(e.title)?{type:"renameSession",session:e.session,request:e.request,title:e.title}:null;case"setRailFilters":return z(e.railFilters)?{type:"setRailFilters",railFilters:e.railFilters}:null;case"sessionMembership":return e.action==="unarchiveAll"?{type:"sessionMembership",action:e.action}:n(e.session)?e.action==="pin"?e.openPinned!==void 0&&typeof e.openPinned!="boolean"?null:{type:"sessionMembership",action:e.action,session:e.session,...e.openPinned===!0?{openPinned:!0}:{}}:e.action==="archive"||e.action==="unarchive"||e.action==="unpin"?{type:"sessionMembership",action:e.action,session:e.session}:null:null;case"setLayout":return e.key==="cardLayout"&&U(e.value)?{type:"setLayout",key:"cardLayout",value:e.value}:e.key==="promptPosition"&&W(e.value)?{type:"setLayout",key:"promptPosition",value:e.value}:null;case"saveState":return{type:"saveState",state:e.state};case"search":return{type:"search",text:h(e.text,"")};case"loadOlder":return n(e.session)?{type:"loadOlder",session:e.session,token:h(e.token,"")}:null;case"openLink":return n(e.href)?{type:"openLink",href:e.href,beside:e.beside===!0}:null;case"openVisualization":return n(e.path)?{type:"openVisualization",path:e.path}:null;case"openImage":return n(e.path)?{type:"openImage",path:e.path,beside:e.beside===!0}:null;case"openTurnDiff":return n(e.key)?{type:"openTurnDiff",key:e.key,beside:e.beside===!0}:null;case"openCommit":return n(e.key)&&n(e.sha)?{type:"openCommit",key:e.key,sha:e.sha,dir:n(e.dir)?e.dir:null,beside:e.beside===!0}:null;case"openFile":return n(e.key)&&n(e.path)?{type:"openFile",key:e.key,path:e.path,beside:e.beside===!0,...n(e.sourceSessionId)?{sourceSessionId:e.sourceSessionId}:{}}:null;case"openSkill":return n(e.key)&&n(e.path)?{type:"openSkill",key:e.key,path:e.path,beside:e.beside===!0}:null;default:return null}}var ft={contextDetail:"handled",ready:"handled",painted:"noop",initialize:"noop",developmentReload:"noop",refresh:"noop",perf:"noop",goBack:"noop",goForward:"noop",newSession:"noop",pinSetup:"noop",unpinSetup:"noop",refreshUsage:"noop",openControl:"noop",requestDefaults:"noop",pick:"noop",draft:"noop",pathCompletion:"handled",answerAsk:"noop",beginFileStaging:"noop",attachFiles:"noop",fileReadError:"noop",fileRejected:"noop",removeFile:"noop",sendPrompt:"noop",importPromptRecovery:"handled",compact:"noop",dismissLive:"noop",restoreLive:"noop",stopTurn:"noop",dequeue:"noop",editQueued:"noop",acceptQueuedEdit:"noop",copy:"handled",note:"handled",armSelectedText:"noop",selectedTextHandoff:"noop",armSessionDetails:"noop",armComposer:"noop",showReaderParent:"handled",showSession:"handled",labelEditor:"handled",setLabels:"handled",setViews:"handled",renameSession:"noop",setRailFilters:"handled",sessionMembership:"handled",setLayout:"handled",saveState:"handled",search:"noop",loadOlder:"noop",openLink:"noop",openVisualization:"noop",openImage:"noop",openTurnDiff:"noop",openCommit:"noop",openFile:"noop",openSkill:"noop"};function gt(t,e,o){let s=e.agent==="codex"?"codex":"claude",r=e.contextTokens,a=e.contextWindow??2e5,i=e.model??"",u=Math.floor(r*.12),c=Math.floor(r*.35),m=Math.floor(r*.38),p=[{key:"instructions",name:"Instructions",tokens:u,relationship:"used"},{key:"messages",name:"Messages",tokens:c,relationship:"used"},{key:"tools",name:"Tool results",tokens:m,relationship:"used"},{key:"other",name:s==="codex"?"Unattributed context":"Tool definitions",tokens:r-u-c-m,relationship:"used"}],d=s==="codex"?{kind:"codex-retained-context",basis:"request",session:t.session,model:i,used:r,capacity:a,categories:p}:{model:i,totalTokens:r,rawMaxTokens:a,categories:[...p.map(b=>({name:b.name,tokens:b.tokens,kind:"used"})),{name:"Free space",tokens:Math.max(0,a-r-Math.floor(a*.1)),kind:"free"},{name:"Compaction buffer",tokens:Math.floor(a*.1),kind:"buffer"}]},l=pe(d,{...t,provider:s,model:i,source:"demo"},o);if(!M(l)||l.status!=="available")throw new Error("Invalid demo context detail");return{type:"contextDetail",detail:l}}var ve={policy:ft,parsePanelToHost:Re,parseHostToPanel:ke,contextReply:gt};window.__ARC_DEMO_SAMPLES__.host=ve;window.__ARC_DEMO_SAMPLES__.labelRules={labelCounts:$,labelEditorReply:re,labelsOf:H,railLabelFields:ne,setSessionLabels:te};window.__ARC_DEMO_SAMPLES__.readRules={newBySession:se};window.__ARC_DEMO_SAMPLES__.commentRules={applyComment:ue,normalizeComments:P};window.__ARC_DEMO_SAMPLES__.isSendChord=le;window.__ARC_DEMO_SAMPLES__.installMenu=ce;})();
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
  let comments = sample.commentRules.normalizeComments(
    Object.values(sample.payloads).flatMap((payload) => payload.comments),
  );
  // A session the demo lists as read starts with its turns marked read, so the panel's read
  // marks and the session list agree. Each save then decides a session's unread state from
  // those marks with the extension's rule.
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
  // Host actions start nothing.
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
          if (Object.hasOwn(sample.payloads, message.session)) {
            selected = message.session;
            render();
          }
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
      const target = event.target;
      const prompt = target instanceof HTMLTextAreaElement && target.id === 'prompt';
      const editable = target instanceof Element && target.closest('input,textarea,[contenteditable]');
      const chord = sample.isSendChord(event, navigator.platform);
      const composing = event.isComposing || event.keyCode === 229;
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
