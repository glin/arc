(()=>{function H(t,e,r){if(t.length<=e)return t;let s=t.slice(0,Math.max(0,e-r.length)),n=s.charCodeAt(s.length-1);return n>=55296&&n<=56319&&(s=s.slice(0,-1)),s+r}var et=/[\p{Cc}\p{Cf}\p{Cs}]/gu,tt=/[\u200c\u200d\u{e0020}-\u{e007f}]/u,nt=/\u200d+$/u,rt=/[^\p{White_Space}\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]/u;function $(t,e){if(typeof t!="string")return"";let n=t.normalize("NFC").replace(/\p{White_Space}+/gu," ").replace(et,i=>tt.test(i)?i:"").normalize("NFC").trim(),a=H(n,e,"").replace(nt,"").trim();return rt.test(a)?a:""}function E(t){return t.toLocaleLowerCase()}function B(t){return t===1?"carried by one session":`carried by ${t} sessions`}var st=20,ot=500,it=2;function U(t){return $(t,40)}function ie(t,e){let r=[],s=new Set;for(let n of t){let a=U(n);if(!a)continue;let i=E(a),u=e.get(i);if(u===void 0&&e.set(i,a),!s.has(i)&&(s.add(i),r.push(u??a),r.length===st))break}return r}function W(t,e){let r=Object.prototype.hasOwnProperty.call(t,e)?t[e]:null;return Array.isArray(r)?[...r]:[]}function ue(t,e,r){let s=!!e&&e!=="__proto__"&&ie(r,new Map).length>0,n=[];for(let[l,c]of Object.entries(t))l!==e&&l!=="__proto__"&&n.push([l,c]);let a=ot-(s?1:0),i=new Map,u={};for(let[l,c]of n.slice(Math.max(0,n.length-Math.max(0,a)))){u[l]=[...c];for(let p of c){let g=E(p);i.has(g)||i.set(g,p)}}return s&&(u[e]=ie(r,i)),u}function at(t){let e=t.slice(0,it),r=t.slice(e.length);return{chips:e,more:r.length?`+${r.length}`:null,rest:r}}function ce(t,e){let{chips:r,more:s,rest:n}=at(t);return{labels:[...t],labelChips:r,labelsMore:s,labelsMoreName:n.length?n.join(", "):null,labelClause:t.length?`${e} ${t.join(", ")}`:null}}function Q(t){let e=new Map;for(let[r,s]of Object.entries(t)){if(!r||r==="__proto__"||!Array.isArray(s))continue;let n=new Set;for(let a of s){let i=U(a);if(!i)continue;let u=E(i);if(n.has(u))continue;n.add(u);let l=e.get(u);l?l.count+=1:e.set(u,{name:i,count:1})}}return[...e.values()].sort((r,s)=>s.count-r.count||r.name.localeCompare(s.name)).map(r=>({...r,countName:B(r.count)}))}function lt(t,e){let r=Q(t),s=new Map(r.map(i=>[E(i.name),i])),n=new Set,a=[];for(let i of W(t,e)){let u=U(i);if(!u)continue;let l=E(u),c=s.get(l);!c||n.has(l)||(n.add(l),a.push({...c,applied:!0}))}for(let i of r)n.has(E(i.name))||a.push({...i,applied:!1});return a}function de(t,e,r,s,n=r){let a=e.find(i=>i.id===r)?.label??r;return{type:"labelEditor",session:n,heading:`${s} ${a}`,rows:lt(t,r)}}function pe(t,e,r,s=0,n=new Map){if(e.has(t.key)||t.promptId!==void 0&&n.get(t.key)===t.promptId)return!0;let a=r.get(t.sessionId)??s;return a>0&&t.startedAt<=a}function fe(t,e,r,s=0,n=new Map){let a=new Set(e),i=new Map;for(let l of t){if(l.kind!=="turn"||!pe(l,a,r,s))continue;let c=i.get(l.sessionId);(c===void 0||l.startedAt>c)&&i.set(l.sessionId,l.startedAt)}let u=new Map;for(let l of t){if(l.kind!=="turn"||(u.has(l.sessionId)||u.set(l.sessionId,0),pe(l,a,r,s,n)))continue;let c=i.get(l.sessionId);c!==void 0&&l.startedAt<=c||u.set(l.sessionId,u.get(l.sessionId)+1)}return u}var K="…";function me(t){return!!t&&/^\S{1,200}$/.test(t)}var dt=200,ge=6e3,_=2e3,pt=/^answer:\d{1,4}$/,ft=/^prompt:\d{1,4}$/;function mt(t){return t==="prompt"||t==="summary"||typeof t=="string"&&pt.test(t)||typeof t=="string"&&ft.test(t)||typeof t=="string"&&t.startsWith("said:")&&me(t.slice(5))?t:"summary"}function gt(t){if(!t||typeof t!="object"||Array.isArray(t))return null;let e=t,r=(p,g)=>typeof p=="string"?H(p,g,K):"",s=p=>typeof p=="number"&&Number.isFinite(p)?p:null,n=r(e.id,_),a=r(e.sessionId,_),i=r(e.turnKey,_),u=r(e.note,ge).trim(),l=s(e.at),c=s(e.turnAt);return!n||!a||!i||!u||l===null||c===null?null:{id:n,sessionId:a,turnKey:i,part:mt(e.part),quote:r(e.quote,ge),offset:typeof e.offset=="number"&&Number.isFinite(e.offset)&&e.offset>=0?Math.trunc(e.offset):void 0,note:u,headline:r(e.headline,_),sessionTitle:r(e.sessionTitle,_),turnAt:c,at:l}}function N(t){let e=[];if(Array.isArray(t))for(let r of t){let s=gt(r);s&&e.push(s)}return e.slice(Math.max(0,e.length-dt))}function ye(t,e){if(!e||typeof e!="object")return[...t];let r=e;if(r.op==="clear"){let i=typeof r.sessionId=="string"?r.sessionId:"";return i?N(t.filter(u=>u.sessionId!==i)):[...t]}if(r.op==="delete"){let i=typeof r.id=="string"?r.id:"";return i?N(t.filter(u=>u.id!==i)):[...t]}if(r.op!=="write")return[...t];let[s]=N([r.note]);if(!s)return[...t];let n=t.findIndex(i=>i.id===s.id),a=[...t];return n<0?a.push(s):a[n]=s,N(a)}function he(){return{places:[],at:-1}}function z(t){return t.at>=0&&t.at<t.places.length?t.places[t.at]:null}function yt(t){return t.at>0}function ht(t){return t.at>=0&&t.at<t.places.length-1}function be(t,e){if(!e||z(t)===e)return t;let r=t.places.slice(0,t.at+1);return r.push(e),bt({places:r,at:r.length-1})}function xe(t){return yt(t)?{places:t.places,at:t.at-1}:null}function we(t){return ht(t)?{places:t.places,at:t.at+1}:null}function bt(t){if(t.places.length<=50)return t;let e=t.places.length-50;return{places:t.places.slice(e),at:t.at-e}}function xt(t){return/^Mac/.test(t||"")}function Se(t,e){return!t||t.key!=="Enter"||t.altKey||t.shiftKey?!1:xt(e)?!!t.metaKey&&!t.ctrlKey:!!t.ctrlKey&&!t.metaKey}var wt="`",sr=wt.repeat(3);function Re(t,e){if(t.defaultPrevented||t.isComposing||t.keyCode===229||t.metaKey)return null;if(/^Win/.test(e))return!t.altKey||t.ctrlKey||t.shiftKey?null:t.key==="ArrowLeft"?"goBack":t.key==="ArrowRight"?"goForward":null;if((t.key==="-"||t.code==="Minus")&&t.ctrlKey){if(t.shiftKey&&!t.altKey)return"goForward";if(!t.shiftKey&&t.altKey===!/^Mac/.test(e))return"goBack"}return null}var ve={productName:"Arc",repositoryName:"arc",publisher:"glin",extensionName:"arc",extensionId:"glin.arc",commandPrefix:"arc",settingsSection:"arc",panelType:"arc.panel",panelStateKey:"arc.panelState",homeDirectory:".arc",snapshotsDirectory:"snapshots",environmentPrefix:"ARC_",visualizationScheme:"arc-visualization:",sessionScheme:"arc-session:",cliPackageName:"@glin/arc",cliExecutable:"arc",vsixFileName:"arc.vsix",baselineScheme:"arc-baseline",patchScheme:"arc-patch"};function St(t){return t.length>0&&!/[\s\u0000-\u001f\u007f-\u009f\\/?#]/u.test(t)}function ke(t){let e=t.trimStart(),r=ve.sessionScheme;if(e.slice(0,r.length).toLowerCase()!==r)return{kind:"other"};try{let s=decodeURIComponent(e.slice(r.length));return St(s)?{kind:"session",session:s}:{kind:"invalid"}}catch{return{kind:"invalid"}}}function Rt(t,e){if(!t.trim())return!0;let r=d=>{throw new Error(`The menu stand-in cannot read the when clause "${t}": ${d}.`)},s=[],n=/\s*('[^']*'|==|!=|&&|\|\||[!()]|[A-Za-z_][\w.:-]*)/y;for(;n.lastIndex<t.length&&t.slice(n.lastIndex).trim();){let d=n.lastIndex,m=n.exec(t);m||r(`unsupported text at "${t.slice(d).trim()}"`),s.push(m[1])}let a=d=>d!==void 0&&/^[A-Za-z_]/.test(d),i=0,u=d=>d?.startsWith("'")?d.slice(1,-1):(a(d)||r(`a comparison has no value after "${s[i-2]} ${s[i-1]}"`),d==="true"?!0:d==="false"?!1:d),l=()=>{let d=s[i++];if(d==="("){let f=p();return s[i++]!==")"&&r("a parenthesis is not closed"),f}if(d==="!")return!l();a(d)||r(d===void 0?"it ends early":`unexpected "${d}"`);let m=e[d];if(s[i]==="=="||s[i]==="!="){let f=s[i++]==="==",b=u(s[i++]);return(m===b||String(m)===String(b))===f}return!!m},c=()=>{let d=l();for(;s[i]==="&&";)i++,d=l()&&d;return d},p=()=>{let d=c();for(;s[i]==="||";)i++,d=c()||d;return d},g=p();return i<s.length&&r(`unexpected "${s[i]}"`),g}function vt(t,e){let r=new Map;for(let s of t){if(!Rt(s.when,e))continue;let[n,a]=s.group.split("@"),i=r.get(n)??[];i.push({order:Number(a)||0,entry:s}),r.set(n,i)}return[...r.keys()].sort((s,n)=>s==="navigation"?-1:n==="navigation"?1:s<n?-1:s>n?1:0).map(s=>r.get(s).sort((n,a)=>n.order-a.order).map(n=>n.entry))}function kt(t){let e=[];for(let r=t;r;r=r.parentElement){let s=r.dataset?.vscodeContext;if(s)try{e.push(JSON.parse(s))}catch{}}return Object.assign({},...e.reverse())}function Te(t,e,r){let s=t.defaultView,n=null;s.addEventListener("contextmenu",a=>{let i=a.target instanceof Element?a.target:null;if(!i||i.closest(".demo-menu"))return;n?.(!1);let u=kt(i),l=vt(e,u);if(!l.length)return;a.preventDefault();let c=t.activeElement instanceof HTMLElement?t.activeElement:null,p=t.createElement("div");p.className="demo-menu",p.setAttribute("role","menu"),l.forEach((h,F)=>{if(F){let M=t.createElement("div");M.setAttribute("role","separator"),p.append(M)}for(let M of h){let I=t.createElement("button");I.type="button",I.setAttribute("role","menuitem"),I.tabIndex=-1,I.textContent=M.title,I.addEventListener("click",()=>{n?.(!0),r(M.command,u)}),p.append(I)}}),t.body.append(p);let g=Array.from(p.querySelectorAll('[role="menuitem"]')),d=i.getBoundingClientRect(),m=a.clientX===0&&a.clientY===0,f=m?d.left:a.clientX,b=m?d.bottom:a.clientY,v=p.offsetWidth,R=p.offsetHeight;p.style.left=`${Math.max(0,f+v>s.innerWidth?s.innerWidth-v:f)}px`,p.style.top=`${Math.max(0,b+R>s.innerHeight?b-R:b)}px`;let w=h=>{(!(h.target instanceof Node)||!p.contains(h.target))&&n?.(!1)},T=h=>{p.remove(),t.removeEventListener("pointerdown",w,!0),s.removeEventListener("blur",S),n=null,h&&c?.isConnected&&c.focus()},S=()=>T(!1);n=T,t.addEventListener("pointerdown",w,!0),s.addEventListener("blur",S),p.addEventListener("keydown",h=>{let F=g.indexOf(t.activeElement),M=h.key==="ArrowDown"?(F+1)%g.length:h.key==="ArrowUp"?(F-1+g.length)%g.length:h.key==="Home"?0:h.key==="End"?g.length-1:-1;M>=0?(h.preventDefault(),g[M].focus()):(h.key==="Escape"||h.key==="Tab")&&(h.preventDefault(),T(!0))}),g[0].focus()})}var Y=[["toolCallTokens","Tool calls"],["toolResultTokens","Tool results"],["attachmentTokens","Attachments"],["assistantMessageTokens","Assistant messages"],["userMessageTokens","User messages"],["redirectedContextTokens","Redirected context"],["unattributedTokens","Unattributed"]];function Ee(t){return t==="pending-tools"||t==="awaiting-measurement"}function L(t){return typeof t=="string"&&t.length<=256*2&&Array.from(t).length<=256}function x(t){return typeof t=="number"&&Number.isSafeInteger(t)&&t>=0}function O(t){if(!t||typeof t!="object")return!1;let e=t;return L(e.session)&&!!e.session&&L(e.model)&&L(e.source)&&(e.provider==="claude"||e.provider==="codex")&&x(e.generation)&&x(e.request)}function q(t,e="unavailable"){return{...t,status:e,capturedAt:Date.now(),measurement:"provider-estimate",used:null,capacity:null,remaining:null,reserve:null,categories:[]}}function Le(t,e,r=Date.now()){if(e.provider==="codex")return Tt(t,e,r);let s=q(e);if(!O(e)||e.provider!=="claude"||!t||typeof t!="object")return s;let n=t;if(!x(n.totalTokens)||!x(n.rawMaxTokens)||n.rawMaxTokens===0||!L(n.model)||!Array.isArray(n.categories)||n.categories.length>32)return s;let a=[],i=new Set,u=null,l=null;for(let m of n.categories){if(!m||typeof m!="object")return s;let f=m;if(!L(f.name)||!f.name.trim()||!x(f.tokens)||typeof f.kind!="string"||!["used","free","buffer","deferred"].includes(f.kind))return s;let b=f.name;if(i.has(b))return s;i.add(b),f.kind==="used"&&a.push({key:b,name:f.name,tokens:f.tokens,relationship:"used"}),f.kind==="free"&&(u=(u??0)+f.tokens),f.kind==="buffer"&&(l=(l??0)+f.tokens)}let c=a.reduce((m,f)=>m+f.tokens,0);if(!x(c)||u!==null&&!x(u)||l!==null&&!x(l))return s;a.sort((m,f)=>f.tokens-m.tokens);let p=a.find(m=>m.key==="Messages"),g=n.messageBreakdown,d;if(p&&g&&typeof g=="object"){let m=g,f=Y.map(([v,R])=>({key:v,name:R,tokens:m[v]})),b=f.reduce((v,R)=>v+(x(R.tokens)?R.tokens:NaN),0);x(b)&&b===p.tokens&&(d=f)}return{...e,model:n.model,capturedAt:r,measurement:"provider-estimate",status:c===n.totalTokens?"available":"mismatch",used:n.totalTokens,capacity:n.rawMaxTokens,remaining:u,reserve:l,categories:a,...d?{messageBreakdown:d}:{}}}function Tt(t,e,r){let s=q(e);if(!O(e)||!t||typeof t!="object")return s;let n=t;if(n.kind==="codex-context-unavailable")return n.session!==e.session||!L(n.model)||!n.model||e.model&&n.model!==e.model||!Ee(n.reason)?s:{...s,capturedAt:r,reason:n.reason};if(n.kind!=="codex-retained-context"||!["request","retained-estimate"].includes(String(n.basis))||n.session!==e.session||!L(n.model)||!n.model||e.model&&n.model!==e.model||!x(n.used)||!x(n.capacity)||!n.capacity||!Array.isArray(n.categories)||!n.categories.length||n.categories.length>32)return s;let a={...e,model:n.model,capturedAt:r,measurement:"local-estimate",basis:n.basis,status:n.categories.reduce((i,u)=>i+(u?.tokens??NaN),0)===n.used?"available":"mismatch",used:n.used,capacity:n.capacity,remaining:Math.max(0,n.capacity-n.used),reserve:null,categories:n.categories.map(i=>({key:i?.key,name:i?.name,tokens:i?.tokens,relationship:i?.relationship}))};return P(a)?(a.categories.sort((i,u)=>u.tokens-i.tokens),a):s}function P(t){if(!O(t))return!1;let e=t;if(!["loading","available","mismatch","unavailable","stale"].includes(e.status)||e.reason!==void 0&&(e.status!=="unavailable"||e.provider!=="codex"||!Ee(e.reason))||!x(e.capturedAt)||!["provider-estimate","local-estimate"].includes(e.measurement)||e.measurement==="local-estimate"&&(e.provider!=="codex"||e.reserve!==null)||e.measurement==="local-estimate"&&!["request","retained-estimate"].includes(String(e.basis))||![e.used,e.capacity,e.remaining,e.reserve].every(a=>a===null||x(a))||!Array.isArray(e.categories)||e.categories.length>32)return!1;let r=new Set;for(let a of e.categories){if(!a||!L(a.key)||!L(a.name)||!a.name.trim()||!x(a.tokens)||a.relationship!=="used"||r.has(a.key))return!1;r.add(a.key)}let s=e.status==="available"||e.status==="mismatch";if(e.messageBreakdown!==void 0){if(e.provider!=="claude"||!s||!Array.isArray(e.messageBreakdown)||e.messageBreakdown.length!==Y.length)return!1;let a=new Set;for(let u of e.messageBreakdown){if(!u||!Y.some(([l,c])=>u.key===l&&u.name===c)||!x(u.tokens)||a.has(u.key))return!1;a.add(u.key)}let i=e.messageBreakdown.reduce((u,l)=>u+l.tokens,0);if(!x(i)||i!==e.categories.find(u=>u.key==="Messages")?.tokens)return!1}let n=e.categories.reduce((a,i)=>a+i.tokens,0);return s&&(e.used===null||!e.capacity||!x(n)||e.status==="available"!=(n===e.used))||!s&&(e.categories.length||e.used!==null||e.capacity!==null)?!1:new TextEncoder().encode(JSON.stringify({type:"contextDetail",detail:e})).length<=32768}var Ce=["latest","cost-desc","cost-asc","needs-you"];var Et="label",Pe="find",Ie="in",Lt=["both","prompt","summary"],Ae={response:"summary",answer:"summary",reply:"summary",ask:"prompt",me:"prompt"},Ne="is",Ct=["input","unread","read","running","warm","active","needsyou","archived","agentrun"],Me={waiting:"input",blocked:"input"},At=[{prefix:"id",field:"session"},{prefix:"session",field:"session"},{prefix:"agent",field:"agent"},{prefix:"title",field:"title"},{prefix:Et,field:"labels"},{prefix:"cost",field:"cost"},{prefix:"cache-expiry",field:"cache-expiry"},{prefix:Ne,field:"status"}],Mt=["cost","cache-expiry"],V="-",Pt=/\s/,It=/^(>|<)(\d+(?:\.\d+)?)$/,Nt=/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i;function _t(t){let e=Nt.exec(t);if(!e)return null;let r=e[2]??"",s=e[3]?Number(e[3]):0;if(!Number.isSafeInteger(s))return null;let n=`${e[1]}${r}`.replace(/^0+/,"");if(!n)return{digits:"0",exponent:0};let a=s-r.length;for(;n.endsWith("0");)n=n.slice(0,-1),a++;return{digits:n,exponent:a}}function Ot(t){let e=[],r="",s=-1,n=!1,a=!1,i=!1,u=l=>{s!==-1&&e.push({text:r,start:s,end:l,quoted:a,quotedHead:i}),r="",s=-1,a=!1,i=!1};for(let l=0;l<t.length;l++){let c=t[l];if(!n&&Pt.test(c)){u(l);continue}if(s===-1&&(s=l,i=c==='"'),c==='"'){if(a=!0,n&&t[l+1]==='"'){r+='"',l++;continue}n=!n;continue}r+=c}return u(t.length),e}function _e(t){let e=t.indexOf(":");return e>0?t.slice(0,e).toLowerCase():""}function Dt(t){let e=_e(t);return e===Pe||e===Ie}function Ft(t){if(t.quotedHead)return null;let e=!t.quotedHead&&t.text.startsWith("-"),r=e?t.text.slice(1):t.text,s=_e(r);if(s!=="session"&&s!=="id")return null;let n=r.slice(r.indexOf(":")+1),a=/^(claude|codex):(.+)$/i.exec(n),i=a?a[1].toLowerCase():"any",u=a?a[2]:n,l={any:new Set,claude:new Set,codex:new Set},c=!u||/[\s:/\\]/.test(u);return c||l[i].add(u),{field:"session",needle:n,identities:l,...s==="id"?{shorthand:!0}:{},...e?{negated:!0}:{},...c?{invalid:!0}:{}}}function Oe(t){return G(t).terms.some(e=>e.invalid)?"Use session IDs or prefixes of at least eight characters. Join positive selectors with OR.":null}function G(t){let e={terms:[],find:[],where:"both",unknownWhere:[],unknownIs:[]},r=!1,s=Ot(t),n=s.map(Ft),a=new Set;for(let u=0;u<s.length;u++){if(s[u].text!=="OR"||s[u].quoted)continue;let l=u-1,c=u+1;for(;l>=0&&s[l].text==="OR"&&!s[l].quoted;)l--;for(;c<s.length&&s[c].text==="OR"&&!s[c].quoted;)c++;if(!n[l]&&!n[c])continue;if(l!==u-1||c!==u+1||!n[l]||!n[c]||n[l].negated||n[c].negated||n[l].invalid||n[c].invalid){e.terms.push({field:"session",needle:"",invalid:!0}),a.add(u);continue}let p=n[l],g=n[c];g.shorthand&&(p.shorthand=!0);for(let d of["any","claude","codex"])for(let m of g.identities[d])p.identities[d].add(m);n[c]=p,a.add(l),a.add(u)}for(let u=0;u<s.length;u++){if(a.has(u))continue;if(n[u]){e.terms.push(n[u]);continue}let{text:l,quoted:c,quotedHead:p}=s[u];if(!l||!p&&l===V||!p&&l.startsWith(V+V))continue;let g=!p&&l[0]===V&&!Dt(l.slice(1)),d=g?l.slice(1):l,m=g?{negated:!0}:{},f=d.toLowerCase(),b=d.indexOf(":"),v=b>0?d.slice(0,b).toLowerCase():"",R=b>0?d.slice(b+1):"",w=R.toLowerCase();if(v===Pe){r=!0,w&&e.find.push(w);continue}if(v===Ie){let S=Lt.find(h=>h===w)||(Object.prototype.hasOwnProperty.call(Ae,w)?Ae[w]:void 0);S?e.where=S:w&&e.unknownWhere.push(w);continue}if(v===Ne){let S=Ct.find(h=>h===w)||(Object.prototype.hasOwnProperty.call(Me,w)?Me[w]:void 0);S?e.terms.push({field:"status",needle:S,...m}):w&&e.unknownIs.push(l);continue}let T=At.find(S=>S.prefix===v&&!(p&&S.field==="session"));if(T){if(Mt.includes(T.field)){let S=c?null:It.exec(R),h=S?_t(S[2]):null;e.terms.push({field:T.field,needle:R,...m,...S&&h?{comparison:{operator:S[1],threshold:h}}:{}});continue}R&&e.terms.push({field:T.field,needle:T.field==="labels"?R:w,...m});continue}r?e.find.push(f):e.terms.push({field:"title",needle:f,plain:!0,...m})}let i=e.terms.filter(u=>u.field==="session"&&u.shorthand&&!u.negated&&!u.invalid);if(i.length>1){let u=i[0];for(let l of i.slice(1))for(let c of["any","claude","codex"])for(let p of l.identities[c])u.identities[c].add(p);e.terms=e.terms.filter(l=>!i.includes(l)||l===u)}return e}var De=40,Fe=200,Tr={taken:"A view already has that name. Choose another name.",unnamed:"A view needs a name. Type one to save it.",limit:`A name is cut to ${De} characters. Two names that agree that far are one view.`};var X=Fe;var Ht="needs-you",$t="is:needsyou -is:archived -is:agentrun",qt=["All sessions","Running","Active","Unread","Needs input","Needs you","Custom"],Dr=new Set(qt.map(t=>Bt(t))),He=["running","active","unread","input"],Vt={running:"is:running -is:archived -is:agentrun",active:"is:active -is:archived -is:agentrun",unread:"is:unread -is:archived -is:agentrun",input:"is:input -is:archived -is:agentrun"};var Fr=X+Math.max($t.length,...He.map(t=>Vt[t].length))+1;function jt(t){return He.includes(t)}function $e(t){return jt(t)||t===Ht}function Bt(t){return t.toLocaleLowerCase()}var Wt=5,Qt=1048576;function qe(...t){let e=new Map;for(let r of t)if(Array.isArray(r))for(let s of r){if(!s||typeof s!="object")continue;let n=s;if(typeof n.id!="string"||!n.id||n.id.length>200||typeof n.source!="string"||n.source.length>200||typeof n.text!="string"||n.text.length>Qt||!Number.isSafeInteger(n.order)||n.order<1||!Number.isSafeInteger(n.revision)||n.revision<0)continue;let a={id:n.id,order:n.order,source:n.source,revision:n.revision,text:n.text};typeof n.owner=="string"&&n.owner.length<=200&&Number.isSafeInteger(n.ownerRevision)&&n.ownerRevision>0&&(a.owner=n.owner,a.ownerRevision=n.ownerRevision,n.accepted===!0&&(a.accepted=!0)),n.setup&&(n.setup.agent==="claude"||n.setup.agent==="codex")&&["model","effort","permissionMode"].every(u=>typeof n.setup[u]=="string"&&n.setup[u].length<=200)&&(a.setup={agent:n.setup.agent,model:n.setup.model,effort:n.setup.effort,permissionMode:n.setup.permissionMode,source:n.setup.source==="inherited"||n.setup.source==="recent"?n.setup.source:"custom"});let i=e.get(n.id);if(i&&(i.order!==a.order||i.source!==a.source||i.revision!==a.revision||i.text!==a.text||i.setup&&a.setup&&["agent","model","effort","permissionMode","source"].some(u=>i.setup[u]!==a.setup[u])))throw new Error("The saved prompt conflicts with another copy.");(!i||(a.ownerRevision??0)>(i.ownerRevision??0))&&e.set(n.id,a)}return[...e.values()].sort((r,s)=>r.order-s.order||(r.id<s.id?-1:r.id>s.id?1:0)).slice(-Wt)}var Ve=64,Kt=200;var zt=["claude","codex"];function J(t){return typeof t=="string"&&t.length<=Kt?t:null}function je(t){if(!t||typeof t!="object")return null;let e=t,r=zt.find(i=>i===e.agent),s=J(e.model),n=J(e.effort),a=J(e.permissionMode);return!r||s===null||n===null||a===null?null:{agent:r,model:s,effort:n,permissionMode:a}}function We(t){return typeof t=="object"&&t!==null&&!Array.isArray(t)}function Be(t){return Number.isSafeInteger(t)&&t>=0}function Qe(t){return Array.isArray(t)&&t.every(e=>typeof e=="string")}function Ue(t){return t===void 0||We(t)&&Be(t.head)&&Be(t.tail)&&Qe(t.ids)}function Z(t){return t===void 0?!0:We(t)&&Number.isSafeInteger(t.revision)&&(t.base===null||Number.isSafeInteger(t.base))&&(t.sessionsBase===void 0||t.sessionsBase===null||Number.isSafeInteger(t.sessionsBase))&&Ue(t.sessionOrder)&&Ue(t.railOrder)&&(t.statsRemoved===void 0||Qe(t.statsRemoved))}var Yt=["compact","one-column","two-columns"],Gt=["above","below"];function ee(t){return typeof t=="string"&&Yt.includes(t)}function te(t){return typeof t=="string"&&Gt.includes(t)}function Xt(t){if(!t||typeof t!="object")return null;let e=t;return!Number.isSafeInteger(e.revision)||e.revision<0||!Number.isFinite(e.since)||e.since<0||!Array.isArray(e.read)||e.read.length>2e3||e.read.some(r=>typeof r!="string")||!e.readTo||typeof e.readTo!="object"||Array.isArray(e.readTo)||Object.values(e.readTo).some(r=>!Number.isFinite(r)||r<0)||!Array.isArray(e.agentRead)||e.agentRead.length>2e3||e.agentRead.some(r=>!Array.isArray(r)||r.length!==2||r.some(s=>typeof s!="string"||!s))?null:{revision:e.revision,read:[...e.read],readTo:{...e.readTo},since:e.since,agentRead:e.agentRead.map(([r,s])=>[r,s])}}function Jt(t){if(!t||typeof t!="object")return null;let e=t;if(typeof e.id!="string"||!e.id||e.id.length>128||!Number.isSafeInteger(e.observedRevision)||e.observedRevision<0)return null;if(e.action==="reset")return Number.isFinite(e.since)&&e.since>=0?{id:e.id,observedRevision:e.observedRevision,action:"reset",since:e.since}:null;if(e.action!=="turn"&&e.action!=="session")return null;let r=e.target;return!r||typeof r.sessionId!="string"||!r.sessionId||!Number.isFinite(r.startedAt)||r.startedAt<0||r.promptId!==void 0&&(typeof r.promptId!="string"||!r.promptId)||typeof e.read!="boolean"||e.action==="session"&&(!Number.isFinite(e.newestAt)||e.newestAt<e.target.startedAt)?null:structuredClone(e)}var Zt={readerDocument:!0,readerReadAdmission:!0,readState:!0,applySessionFilter:!0,health:!0,visibility:!0,startupProgress:!0,contextDetail:!0,focusProjectSpend:!0,openLauncher:!0,labelEditor:!0,labelsChanged:!0,openLabelEditor:!0,showSessionDetails:!0,openViewEditor:!0,openSessionRename:!0,sessionRenameResult:!0,focusComposer:!0,pathCompletion:!0,insertPrompt:!0,fileStaging:!0,fileStagingRejected:!0,usage:!0,askRejected:!0,projectSpend:!0,layout:!0,live:!0,activity:!0,selection:!0,rail:!0,openPick:!0,takeDraft:!0,takeQueuedDraft:!0,promptRecovery:!0,requestPromptRecovery:!0,restoreDraft:!0,notes:!0,openComment:!0,sendSelectedText:!0,setRead:!0,forgetState:!0,setSessionRead:!0,setSessionArchived:!0,setSessionPinned:!0,setComposerHidden:!0,results:!0,render:!0};function y(t){return t!==null&&typeof t=="object"&&!Array.isArray(t)?t:null}function o(t){return typeof t=="string"}function C(t){return typeof t=="number"&&Number.isFinite(t)}function en(t){return o(t)&&Object.prototype.hasOwnProperty.call(Zt,t)}function ne(t){return t===void 0||o(t)}function A(t){return Array.isArray(t)&&t.every(e=>y(e)!==null)}function D(t){return Array.isArray(t)&&t.every(o)}function re(t){let e=y(t);return!!e&&o(e.name)&&C(e.count)&&o(e.countName)}function tn(t){let e=y(t);return re(t)&&typeof e?.applied=="boolean"}function nn(t){let e=y(t);return!!e&&o(e.id)&&e.id!==""&&o(e.name)&&o(e.query)&&typeof e.archived=="boolean"}function se(t){return Array.isArray(t)&&t.every(nn)}function rn(t){let e=y(t);return!!e&&o(e.id)&&e.id!==""&&o(e.name)&&o(e.query)&&Ce.includes(e.sort)&&(e.lens===void 0||e.lens===null||$e(e.lens))}function oe(t){return Array.isArray(t)&&t.every(rn)}function ze(t){let e=y(t);return!!e&&o(e.provisional)&&o(e.durable)}function sn(t){let e=y(t);return!!e&&o(e.id)&&o(e.label)&&o(e.name)&&C(e.size)&&(e.preview===null||o(e.preview))&&o(e.kind)&&o(e.stem)&&o(e.ext)&&o(e.sizeLabel)&&ne(e.removeLabel)&&ne(e.removeName)&&ne(e.removeControl)}function on(t){let e=y(t);return!!e&&o(e.name)&&typeof e.directory=="boolean"&&o(e.label)&&o(e.accessibleName)&&o(e.completion)}function an(t){let e=y(t);return!!e&&(e.kind==="prompt"||e.kind==="compact")&&(e.state==="sent"||e.state==="running"||e.state==="failed"||e.state==="done"||e.state==="interrupted")&&(e.tone==="running"||e.tone==="failed"||e.tone==="done"||e.tone==="interrupted")&&o(e.relative)&&o(e.absolute)&&o(e.agent)&&o(e.model)&&o(e.label)&&o(e.headline)&&o(e.status)&&o(e.reply)&&C(e.at)&&(e.since===null||C(e.since))&&o(e.dismissLabel)&&o(e.dismissName)&&o(e.dismissControl)&&o(e.restoreLabel)&&o(e.restoreName)&&o(e.restoreControl)&&o(e.reason)&&Array.isArray(e.files)&&e.files.every(sn)}function k(t,e){return typeof t=="string"?t:e}function Ye(t,e){return typeof t=="number"&&Number.isFinite(t)?t:e}var ln=24,un=8,cn=1e6;function dn(t){let e=Array.isArray(t.types)?t.types.filter(o).slice(0,ln).map(s=>s.slice(0,120)):[],r=Array.isArray(t.values)?t.values.flatMap(s=>{let n=y(s);return n&&o(n.type)&&o(n.data)&&n.data.length<=cn?[{type:n.type.slice(0,120),data:n.data}]:[]}).slice(0,un):[];return{types:e,values:r}}function Ge(t){let e=y(t);return e?e.kind==="row"&&o(e.key)?{kind:"row",key:e.key}:e.kind==="custom"&&o(e.agent)&&o(e.model)&&o(e.effort)&&o(e.permissionMode)?{kind:"custom",agent:e.agent,model:e.model,effort:e.effort,permissionMode:e.permissionMode}:null:null}function pn(t){let e=y(t);if(!e)return null;if(e.decision==="allow")return{decision:"allow"};if(e.decision==="deny"&&o(e.reason))return{decision:"deny",reason:e.reason};if(e.decision==="answer"){let r=y(e.answers);if(!r)return null;let s={};for(let[n,a]of Object.entries(r)){let i=y(a);if(!i||!Array.isArray(i.labels)||!i.labels.every(o)||!o(i.written))return null;s[n]={labels:[...i.labels],written:i.written}}return{decision:"answer",answers:s}}return null}function Xe(t){let e=y(t);if(!e)return null;switch(e.type){case"applySessionFilter":return Object.keys(e).sort().join(",")==="deadline,query,request,type"&&o(e.request)&&e.request.length>0&&e.request.length<=128&&o(e.query)&&e.query.length<=X&&!Oe(e.query)&&C(e.deadline)?{type:"applySessionFilter",request:e.request,query:e.query,deadline:e.deadline}:null;case"health":return Number.isSafeInteger(e.sequence)&&e.sequence>0?{type:"health",sequence:e.sequence}:null;case"visibility":return typeof e.visible=="boolean"&&Number.isSafeInteger(e.revision)&&e.revision>=0?{type:"visibility",visible:e.visible,revision:e.revision}:null;case"startupProgress":return j(e.queryContext)&&(e.queryOnly===void 0||typeof e.queryOnly=="boolean")&&(e.complete===void 0||typeof e.complete=="boolean")&&(e.failed===void 0||typeof e.failed=="boolean")&&(e.held===void 0||typeof e.held=="boolean")&&Number.isSafeInteger(e.generation)&&Number.isSafeInteger(e.sequence)&&o(e.epoch)&&Number.isSafeInteger(e.completed)&&Number.isSafeInteger(e.known)&&e.generation>=0&&e.sequence>=0&&e.completed>=0&&e.known>=e.completed?e:null;case"focusProjectSpend":return{type:"focusProjectSpend"};case"openLauncher":return{type:"openLauncher",custom:e.custom===!0};case"labelEditor":return o(e.session)&&o(e.heading)&&Array.isArray(e.rows)&&e.rows.every(tn)?{type:"labelEditor",session:e.session,heading:e.heading,rows:e.rows}:null;case"labelsChanged":return o(e.session)?{type:"labelsChanged",session:e.session}:null;case"openLabelEditor":return o(e.session)?{type:"openLabelEditor",session:e.session}:null;case"showSessionDetails":return o(e.session)&&e.session.length>0?{type:"showSessionDetails",session:e.session}:null;case"openViewEditor":return o(e.view)&&(e.mode==="rename"||e.mode==="delete")?{type:"openViewEditor",view:e.view,mode:e.mode}:null;case"openSessionRename":return o(e.session)&&e.session.length>0&&o(e.title)?{type:"openSessionRename",session:e.session,title:e.title}:null;case"sessionRenameResult":return o(e.session)&&e.session.length>0&&Number.isSafeInteger(e.request)&&o(e.title)&&o(e.error)?{type:"sessionRenameResult",session:e.session,request:e.request,title:e.title,error:e.error}:null;case"focusComposer":return o(e.session)?{type:"focusComposer",session:e.session}:null;case"contextDetail":if(e.detail&&typeof e.detail=="object"&&"messageBreakdown"in e.detail&&!P(e.detail)){let{messageBreakdown:r,...s}=e.detail;if(P(s))return{type:"contextDetail",detail:s}}return P(e.detail)?{type:"contextDetail",detail:e.detail}:O(e.detail)?{type:"contextDetail",detail:q({session:e.detail.session,provider:e.detail.provider,model:e.detail.model,source:e.detail.source,generation:e.detail.generation,request:e.detail.request})}:null;case"pathCompletion":return o(e.session)&&C(e.request)&&o(e.token)&&C(e.caret)&&Array.isArray(e.rows)&&e.rows.every(on)?{type:"pathCompletion",session:e.session,request:e.request,token:e.token,caret:e.caret,rows:e.rows}:null;case"insertPrompt":return o(e.session)&&o(e.text)?{type:"insertPrompt",session:e.session,text:e.text}:null;case"fileStaging":return o(e.session)?{type:"fileStaging",session:e.session,token:k(e.token,""),pending:e.pending===!0,...typeof e.count=="number"&&Number.isInteger(e.count)&&e.count>0?{count:e.count}:{}}:null;case"fileStagingRejected":return o(e.session)&&o(e.token)?{type:"fileStagingRejected",session:e.session,token:e.token}:null;case"usage":return{type:"usage",usage:e.usage};case"askRejected":return o(e.session)&&o(e.id)?{type:"askRejected",session:e.session,id:e.id}:null;case"projectSpend":return{type:"projectSpend",projectSpend:e.projectSpend};case"layout":{let r=y(e.layout);return r&&ee(r.cardLayout)&&te(r.promptPosition)?{type:"layout",layout:{cardLayout:r.cardLayout,promptPosition:r.promptPosition}}:null}case"live":return o(e.session)&&Array.isArray(e.live)&&e.live.every(an)?{type:"live",session:e.session,live:e.live}:null;case"activity":return A(e.cards)?{type:"activity",cards:e.cards}:o(e.session)?{type:"activity",session:e.session,card:e.card}:null;case"selection":return j(e.queryContext)&&A(e.cards)&&A(e.sessions)&&A(e.rail)&&y(e.stats)!==null&&D(e.replaces)?e:null;case"rail":{let r=y(e.stats),s=e.sessionAdoptions===void 0?[]:e.sessionAdoptions;return j(e.queryContext)&&A(e.rail)&&r!==null&&Array.isArray(e.labels)&&e.labels.every(re)&&se(e.views)&&oe(e.railFilters)&&Array.isArray(s)&&s.every(ze)&&D(e.hidden)&&D(e.pinnedTop)&&Z(e.rows)?{type:"rail",...e.queryContext===void 0?{}:{queryContext:e.queryContext},rail:e.rail,stats:r,labels:e.labels,views:e.views,railFilters:e.railFilters,sessionAdoptions:s,hidden:e.hidden,pinnedTop:e.pinnedTop,...e.rows===void 0?{}:{rows:e.rows}}:null}case"openPick":return o(e.control)?{type:"openPick",control:e.control}:null;case"takeDraft":return o(e.session)&&o(e.text)?{type:"takeDraft",session:e.session,text:e.text}:null;case"takeQueuedDraft":return o(e.session)&&o(e.text)&&Number.isSafeInteger(e.revision)&&e.revision>=0&&o(e.value)?{type:"takeQueuedDraft",session:e.session,text:e.text,revision:e.revision,value:e.value}:null;case"promptRecovery":try{return{type:"promptRecovery",submittedPrompts:qe(e.submittedPrompts)}}catch{return null}case"requestPromptRecovery":return o(e.request)?{type:"requestPromptRecovery",request:e.request}:null;case"restoreDraft":return o(e.session)&&o(e.text)&&typeof e.revision=="number"?{type:"restoreDraft",session:e.session,text:e.text,revision:e.revision}:null;case"notes":return{type:"notes",comments:e.comments};case"openComment":return o(e.key)?{type:"openComment",key:e.key}:null;case"sendSelectedText":return o(e.key)&&e.key.length>0&&typeof e.copyLabels=="boolean"?{type:"sendSelectedText",key:e.key,copyLabels:e.copyLabels}:null;case"readerDocument":return[e.readerPageId,e.documentId,e.challenge].every(r=>typeof r=="string"&&/^[a-f0-9]{32}$/.test(r))?e:null;case"readerReadAdmission":return o(e.id)&&e.id.length<=128&&typeof e.admitted=="boolean"?{type:"readerReadAdmission",id:e.id,admitted:e.admitted}:null;case"readState":{let r=Xt(e.state);return r?{type:"readState",state:r}:null}case"setRead":return o(e.key)?{type:"setRead",key:e.key,read:e.read===!0}:null;case"forgetState":return typeof e.since=="number"?{type:"forgetState",since:e.since}:null;case"setSessionRead":return o(e.session)?{type:"setSessionRead",session:e.session,read:e.read===!0}:null;case"setSessionArchived":return o(e.session)?{type:"setSessionArchived",session:e.session,archived:e.archived===!0}:null;case"setSessionPinned":return o(e.session)?{type:"setSessionPinned",session:e.session,pinned:e.pinned===!0}:null;case"setComposerHidden":return{type:"setComposerHidden",hidden:e.hidden===!0};case"results":return o(e.query)&&o(e.scope)?{type:"results",query:e.query,hits:e.hits,scope:e.scope}:null;case"render":{let r=e.sessionAdoptions;return j(e.queryContext)&&A(e.cards)&&A(e.sessions)&&A(e.rail)&&y(e.stats)!==null&&D(e.hidden)&&D(e.pinnedTop)&&A(e.comments)&&Array.isArray(e.labels)&&e.labels.every(re)&&se(e.views)&&oe(e.railFilters)&&Array.isArray(e.iconFonts)&&e.iconFonts.every(o)&&Array.isArray(r)&&r.every(ze)&&Z(e.rows)?e:null}default:return null}}function j(t){if(t===void 0)return!0;let e=y(t);return!!e&&["complete","incomplete","unavailable"].includes(String(e.coverage))&&o(e.scope)&&o(e.revision)&&Array.isArray(e.identities)&&e.identities.every(r=>{let s=y(r);return!!s&&o(s.sessionId)&&o(s.agent)})}function Je(t){let e=y(t);if(!e)return null;switch(e.type){case"readerRead":{let r=Jt(e.operation);return r?{type:"readerRead",operation:r}:null}case"sessionFilterApplied":return Object.keys(e).sort().join(",")==="request,state,type"&&o(e.request)&&e.request.length>0&&e.request.length<=128&&y(e.state)?{type:"sessionFilterApplied",request:e.request,state:e.state}:null;case"health":return Number.isSafeInteger(e.sequence)&&e.sequence>0?{type:"health",sequence:e.sequence}:null;case"ready":{let r=["readerPageId","readerDocumentId","readerChallenge"];return r.some(s=>e[s]!==void 0&&(typeof e[s]!="string"||!/^[a-f0-9]{32}$/.test(e[s])))||e.readerChallenge!==void 0&&(e.readerPageId===void 0||e.readerDocumentId===void 0)?null:{type:"ready",...Object.fromEntries(r.filter(s=>e[s]!==void 0).map(s=>[s,e[s]]))}}case"painted":return Number.isSafeInteger(e.generation)&&e.generation>=0&&(e.stage==="railReady"||e.stage==="firstCard"||e.stage==="completeRender")?{type:"painted",generation:e.generation,stage:e.stage,...e.usableRows===!0?{usableRows:!0}:{}}:null;case"rowsGap":return{type:"rowsGap"};case"initialize":return{type:"initialize"};case"developmentReload":return{type:"developmentReload"};case"refresh":return{type:"refresh"};case"perf":return en(e.kind)&&C(e.ms)&&e.ms>=0?{type:"perf",kind:e.kind,ms:e.ms}:null;case"goBack":return{type:"goBack"};case"goForward":return{type:"goForward"};case"newSession":{if(e.owner!==void 0&&!o(e.owner))return null;let r=e.owner===void 0?{}:{owner:e.owner};if(e.request===void 0)return{type:"newSession",...r};let s=Ge(e.request);return s?{type:"newSession",request:s,...r}:null}case"pinSetup":{if(e.owner!==void 0&&!o(e.owner))return null;let r=e.owner===void 0?{}:{owner:e.owner},s=Ge(e.request);if(!s)return null;if(s.kind==="custom")return{type:"pinSetup",request:s,...r};let n=je(y(e.request)?.values);return n?{type:"pinSetup",request:{...s,values:n},...r}:null}case"unpinSetup":return(e.owner===void 0||o(e.owner))&&o(e.id)&&e.id.trim().length>0&&e.id.length<=Ve?{type:"unpinSetup",id:e.id,...e.owner===void 0?{}:{owner:e.owner}}:null;case"refreshUsage":return{type:"refreshUsage",agent:o(e.agent)?e.agent:null,force:e.force===!0};case"requestDefaults":return(e.agent==="claude"||e.agent==="codex")&&o(e.model)&&e.model.length<=200?{type:"requestDefaults",agent:e.agent,model:e.model}:null;case"openControl":return o(e.control)&&o(e.session)?{type:"openControl",control:e.control,session:e.session}:null;case"pick":return o(e.agent)&&o(e.value)&&o(e.session)?{type:"pick",control:String(e.control),agent:e.agent,session:e.session,model:k(e.model,""),value:e.value}:null;case"draft":return o(e.text)&&o(e.session)?{type:"draft",text:e.text,keep:k(e.keep,e.text),session:e.session,...Number.isSafeInteger(e.revision)?{revision:e.revision}:{}}:null;case"contextDetail":return L(e.session)&&e.session&&x(e.request)&&x(e.generation)?{type:"contextDetail",session:e.session,request:e.request,generation:e.generation}:null;case"pathCompletion":return o(e.session)&&C(e.request)&&o(e.token)&&C(e.caret)?{type:"pathCompletion",session:e.session,request:e.request,token:e.token,caret:e.caret}:null;case"answerAsk":{if(!o(e.session)||!o(e.id))return null;let r=pn(e.answer);return r?{type:"answerAsk",session:e.session,id:e.id,answer:r}:null}case"dropUris":return o(e.session)?{type:"dropUris",session:e.session,...dn(e)}:null;case"beginFileStaging":return o(e.session)?{type:"beginFileStaging",session:e.session,token:k(e.token,"")}:null;case"attachFiles":return o(e.session)?{type:"attachFiles",session:e.session,token:k(e.token,""),clipboard:e.clipboard===!0,files:e.files}:null;case"fileReadError":return o(e.session)?{type:"fileReadError",session:e.session,token:k(e.token,""),name:k(e.name,"")}:null;case"fileRejected":return o(e.session)?{type:"fileRejected",session:e.session,code:k(e.code,"read"),name:k(e.name,""),size:Ye(e.size,0),rejected:Ye(e.rejected,0)}:null;case"removeFile":return o(e.session)&&o(e.value)?{type:"removeFile",session:e.session,value:e.value}:null;case"importPromptRecovery":return{type:"importPromptRecovery",submittedPrompts:e.submittedPrompts,...o(e.request)?{request:e.request}:{}};case"sendPrompt":return o(e.text)&&o(e.session)?{type:"sendPrompt",text:e.text,session:e.session,...e.attempt&&typeof e.attempt=="object"?{attempt:e.attempt}:{},revision:typeof e.revision=="number"&&Number.isSafeInteger(e.revision)&&e.revision>=0?e.revision:0}:null;case"compact":return o(e.session)?{type:"compact",session:e.session}:null;case"dismissLive":return o(e.session)?{type:"dismissLive",session:e.session,kind:k(e.kind,"")}:null;case"restoreLive":return o(e.session)?{type:"restoreLive",session:e.session,kind:k(e.kind,"")}:null;case"stopTurn":return o(e.session)?{type:"stopTurn",session:e.session}:null;case"dequeue":return o(e.value)&&o(e.session)?{type:"dequeue",value:e.value,session:e.session}:null;case"editQueued":return o(e.value)&&o(e.session)&&Number.isSafeInteger(e.revision)&&e.revision>=0?{type:"editQueued",value:e.value,session:e.session,revision:e.revision}:null;case"acceptQueuedEdit":return o(e.value)&&o(e.session)&&Number.isSafeInteger(e.revision)&&e.revision>=0&&Number.isSafeInteger(e.currentRevision)&&e.currentRevision>=0&&typeof e.accepted=="boolean"?{type:"acceptQueuedEdit",value:e.value,session:e.session,revision:e.revision,currentRevision:e.currentRevision,accepted:e.accepted}:null;case"copy":return o(e.text)?{type:"copy",text:e.text}:null;case"note":return{type:"note",note:e.note};case"armSelectedText":return o(e.session)&&e.session.length>0&&o(e.key)&&e.key.length>0?{type:"armSelectedText",session:e.session,key:e.key}:null;case"selectedTextHandoff":return o(e.session)&&e.session.length>0&&o(e.key)&&e.key.length>0&&o(e.text)&&e.text.trim().length>0&&typeof e.copyLabels=="boolean"?{type:"selectedTextHandoff",session:e.session,key:e.key,text:e.text,copyLabels:e.copyLabels}:null;case"armSessionDetails":return o(e.session)&&e.session.length>0?{type:"armSessionDetails",session:e.session}:null;case"armComposer":return{type:"armComposer"};case"showReaderParent":return o(e.session)&&e.session.length>0?{type:"showReaderParent",session:e.session}:null;case"showSession":return o(e.session)&&(e.responseLink===void 0||e.responseLink===!0)?{type:"showSession",session:e.session,...e.parent===!0?{parent:!0}:{},...e.responseLink===!0?{responseLink:!0}:{}}:null;case"labelEditor":return o(e.session)?{type:"labelEditor",session:e.session}:null;case"setLabels":return o(e.session)&&Array.isArray(e.names)?{type:"setLabels",session:e.session,names:e.names.filter(o)}:null;case"setViews":return se(e.views)?{type:"setViews",views:e.views}:null;case"renameSession":return o(e.session)&&e.session.length>0&&Number.isSafeInteger(e.request)&&o(e.title)?{type:"renameSession",session:e.session,request:e.request,title:e.title}:null;case"setRailFilters":return oe(e.railFilters)?{type:"setRailFilters",railFilters:e.railFilters}:null;case"sessionMembership":return o(e.session)?e.action==="pin"?e.openPinned!==void 0&&typeof e.openPinned!="boolean"?null:{type:"sessionMembership",action:e.action,session:e.session,...e.openPinned===!0?{openPinned:!0}:{}}:e.action==="archive"||e.action==="unarchive"||e.action==="unpin"?{type:"sessionMembership",action:e.action,session:e.session}:null:null;case"setLayout":return e.key==="cardLayout"&&ee(e.value)?{type:"setLayout",key:"cardLayout",value:e.value}:e.key==="promptPosition"&&te(e.value)?{type:"setLayout",key:"promptPosition",value:e.value}:null;case"exportSession":return o(e.session)&&e.session.length>0?{type:"exportSession",session:e.session}:null;case"saveState":return{type:"saveState",state:e.state};case"search":return{type:"search",text:k(e.text,""),...e.retained===!0?{retained:!0}:{}};case"loadOlder":return o(e.session)?{type:"loadOlder",session:e.session,token:k(e.token,"")}:null;case"openLink":if(e.destination!==void 0){let r=y(e.destination);return r&&r.kind==="fileCitation"&&o(r.path)&&e.href===void 0?{type:"openLink",destination:{kind:"fileCitation",path:r.path},beside:e.beside===!0}:null}return o(e.href)?{type:"openLink",href:e.href,beside:e.beside===!0}:null;case"openVisualization":return o(e.path)?{type:"openVisualization",path:e.path}:null;case"openImage":return o(e.path)?{type:"openImage",path:e.path,beside:e.beside===!0}:null;case"openTurnDiff":return o(e.key)?{type:"openTurnDiff",key:e.key,beside:e.beside===!0}:null;case"openCommit":return o(e.key)&&o(e.sha)?{type:"openCommit",key:e.key,sha:e.sha,dir:o(e.dir)?e.dir:null,beside:e.beside===!0}:null;case"openFile":return o(e.key)&&o(e.path)?{type:"openFile",key:e.key,path:e.path,beside:e.beside===!0,...o(e.sourceSessionId)?{sourceSessionId:e.sourceSessionId}:{}}:null;case"openSkill":return o(e.key)&&o(e.path)?{type:"openSkill",key:e.key,path:e.path,beside:e.beside===!0}:null;default:return null}}var fn={readerRead:"noop",sessionFilterApplied:"noop",health:"noop",contextDetail:"handled",ready:"handled",rowsGap:"noop",painted:"noop",initialize:"noop",developmentReload:"noop",refresh:"noop",perf:"noop",goBack:"handled",goForward:"handled",newSession:"noop",pinSetup:"noop",unpinSetup:"noop",refreshUsage:"noop",openControl:"noop",requestDefaults:"noop",pick:"noop",draft:"noop",pathCompletion:"handled",answerAsk:"noop",beginFileStaging:"noop",attachFiles:"noop",dropUris:"noop",fileReadError:"noop",fileRejected:"noop",removeFile:"noop",sendPrompt:"noop",importPromptRecovery:"handled",compact:"noop",dismissLive:"noop",restoreLive:"noop",stopTurn:"noop",dequeue:"noop",editQueued:"noop",acceptQueuedEdit:"noop",copy:"handled",note:"handled",armSelectedText:"noop",selectedTextHandoff:"noop",armSessionDetails:"noop",armComposer:"noop",showReaderParent:"handled",showSession:"handled",labelEditor:"handled",setLabels:"handled",setViews:"handled",renameSession:"noop",setRailFilters:"handled",sessionMembership:"handled",setLayout:"handled",exportSession:"handled",saveState:"handled",search:"noop",loadOlder:"noop",openLink:"noop",openVisualization:"noop",openImage:"noop",openTurnDiff:"noop",openCommit:"noop",openFile:"noop",openSkill:"noop"};function mn(t,e,r){let s=e.agent==="codex"?"codex":"claude",n=e.contextTokens,a=e.contextWindow??2e5,i=e.model??"",u=Math.floor(n*.12),l=Math.floor(n*.35),c=Math.floor(n*.38),p=[{key:"instructions",name:s==="codex"?"Instructions":"System prompt",tokens:u,relationship:"used"},{key:"messages",name:"Messages",tokens:l,relationship:"used"},{key:"tools",name:s==="codex"?"Tool results":"System tools",tokens:c,relationship:"used"},{key:"other",name:s==="codex"?"Unattributed context":"Memory files",tokens:n-u-l-c,relationship:"used"}],g=Math.floor(l*.3),d=Math.floor(l*.25),m=Math.floor(l*.2),f=Math.floor(l*.15),b=Math.floor(l*.07),v={toolCallTokens:m,toolResultTokens:g,attachmentTokens:0,assistantMessageTokens:d,userMessageTokens:f,redirectedContextTokens:b,unattributedTokens:l-m-g-d-f-b},R=s==="codex"?{kind:"codex-retained-context",basis:"request",session:t.session,model:i,used:n,capacity:a,categories:p}:{model:i,totalTokens:n,rawMaxTokens:a,categories:[...p.map(T=>({name:T.name,tokens:T.tokens,kind:"used"})),{name:"Free space",tokens:Math.max(0,a-n-Math.floor(a*.1)),kind:"free"},{name:"Compaction buffer",tokens:Math.floor(a*.1),kind:"buffer"}],messageBreakdown:v},w=Le(R,{...t,provider:s,model:i,source:"demo"},r);if(!P(w)||w.status!=="available")throw new Error("Invalid demo context detail");return{type:"contextDetail",detail:w}}var Ze={policy:fn,parsePanelToHost:Je,parseHostToPanel:Xe,contextReply:mn};window.__ARC_DEMO_SAMPLES__.host=Ze;window.__ARC_DEMO_SAMPLES__.labelRules={labelCounts:Q,labelEditorReply:de,labelsOf:W,railLabelFields:ce,setSessionLabels:ue};window.__ARC_DEMO_SAMPLES__.readRules={newBySession:fe};window.__ARC_DEMO_SAMPLES__.commentRules={applyComment:ye,normalizeComments:N};window.__ARC_DEMO_SAMPLES__.placeRules={emptyTrail:he,visitPlace:be,stepBack:xe,stepForward:we,trailPlace:z};window.__ARC_DEMO_SAMPLES__.isSendChord=Se;window.__ARC_DEMO_SAMPLES__.navigationShortcut=Re;window.__ARC_DEMO_SAMPLES__.parseSessionLink=ke;window.__ARC_DEMO_SAMPLES__.installMenu=Te;})();
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
