(()=>{function q(t,e,n){if(t.length<=e)return t;let o=t.slice(0,Math.max(0,e-n.length)),r=o.charCodeAt(o.length-1);return r>=55296&&r<=56319&&(o=o.slice(0,-1)),o+n}var pt=/[\p{Cc}\p{Cf}\p{Cs}]/gu,ft=/[\u200c\u200d\u{e0020}-\u{e007f}]/u,mt=/\u200d+$/u,gt=/[^\p{White_Space}\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]/u;function B(t,e){if(typeof t!="string")return"";let r=t.normalize("NFC").replace(/\p{White_Space}+/gu," ").replace(pt,i=>ft.test(i)?i:"").normalize("NFC").trim(),a=q(r,e,"").replace(mt,"").trim();return gt.test(a)?a:""}function M(t){return t.toLocaleLowerCase()}function Q(t){return t===1?"carried by one session":`carried by ${t} sessions`}var ht=20,yt=500,bt=2;function K(t){return B(t,40)}function fe(t,e){let n=[],o=new Set;for(let r of t){let a=K(r);if(!a)continue;let i=M(a),u=e.get(i);if(u===void 0&&e.set(i,a),!o.has(i)&&(o.add(i),n.push(u??a),n.length===ht))break}return n}function z(t,e){let n=Object.prototype.hasOwnProperty.call(t,e)?t[e]:null;return Array.isArray(n)?[...n]:[]}function he(t,e,n){let o=!!e&&e!=="__proto__"&&fe(n,new Map).length>0,r=[];for(let[l,c]of Object.entries(t))l!==e&&l!=="__proto__"&&r.push([l,c]);let a=yt-(o?1:0),i=new Map,u={};for(let[l,c]of r.slice(Math.max(0,r.length-Math.max(0,a)))){u[l]=[...c];for(let d of c){let g=M(d);i.has(g)||i.set(g,d)}}return o&&(u[e]=fe(n,i)),u}function xt(t){let e=t.slice(0,bt),n=t.slice(e.length);return{chips:e,more:n.length?`+${n.length}`:null,rest:n}}function ye(t,e){let{chips:n,more:o,rest:r}=xt(t);return{labels:[...t],labelChips:n,labelsMore:o,labelsMoreName:r.length?r.join(", "):null,labelClause:t.length?`${e} ${t.join(", ")}`:null}}function Y(t){let e=new Map;for(let[n,o]of Object.entries(t)){if(!n||n==="__proto__"||!Array.isArray(o))continue;let r=new Set;for(let a of o){let i=K(a);if(!i)continue;let u=M(i);if(r.has(u))continue;r.add(u);let l=e.get(u);l?l.count+=1:e.set(u,{name:i,count:1})}}return[...e.values()].sort((n,o)=>o.count-n.count||n.name.localeCompare(o.name)).map(n=>({...n,countName:Q(n.count)}))}function wt(t,e){let n=Y(t),o=new Map(n.map(i=>[M(i.name),i])),r=new Set,a=[];for(let i of z(t,e)){let u=K(i);if(!u)continue;let l=M(u),c=o.get(l);!c||r.has(l)||(r.add(l),a.push({...c,applied:!0}))}for(let i of n)r.has(M(i.name))||a.push({...i,applied:!1});return a}function be(t,e,n,o,r=n){let a=e.find(i=>i.id===n)?.label??n;return{type:"labelEditor",session:r,heading:`${o} ${a}`,rows:wt(t,n)}}function xe(t,e,n,o=0,r=new Map){if(e.has(t.key)||t.promptId!==void 0&&r.get(t.key)===t.promptId)return!0;let a=n.get(t.sessionId)??o;return a>0&&t.startedAt<=a}function we(t,e,n,o=0,r=new Map){let a=e instanceof Set?e:new Set(e),i=new Map;for(let l of t){if(l.kind!=="turn"||l.origin==="scheduled"||!xe(l,a,n,o))continue;let c=i.get(l.sessionId);(c===void 0||l.startedAt>c)&&i.set(l.sessionId,l.startedAt)}let u=new Map;for(let l of t){if(l.kind!=="turn"||(u.has(l.sessionId)||u.set(l.sessionId,0),l.origin==="scheduled"||xe(l,a,n,o,r)))continue;let c=i.get(l.sessionId);c!==void 0&&l.startedAt<=c||u.set(l.sessionId,u.get(l.sessionId)+1)}return u}var T={kind:"recorded",sources:["https://platform.claude.com/docs/en/build-with-claude/prompt-caching","https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html"]},D={prefixes:/^(?:global|[a-z]{2})?$/,regionalMultiplier:1.1,window:272e3,cachePolicy:{kind:"documented",lifetime:"30m",sources:["https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html"]}};var Rt=[{effortChangeKeepsCache:/^claude-fable-5-1(?:-\d{8})?(?:\[[^\]]+\])?$/,pattern:/^claude-(fable|mythos)-5-1(?:-\d{8})?(?:\[[^\]]+\])?$/,rate:{input:10,cacheRead:.25,output:50},cachePolicy:T,window:1e6},{pattern:/^claude-(fable|mythos)-5(?:-\d{8})?(?:\[[^\]]+\])?$/,rate:{input:10,output:50},cachePolicy:T,window:1e6},{effortChangeKeepsCache:!0,pattern:/^claude-opus-5-5(?:-\d{8})?(?:\[[^\]]+\])?$/,rate:{input:4,cacheRead:.2,output:20},fast:{input:8,cacheRead:.4,output:40},cachePolicy:T,window:1e6},{pattern:/^claude-opus-(5|4-8)(?:-\d{8})?(?:\[[^\]]+\])?$/,rate:{input:5,output:25},fast:{input:10,output:50},cachePolicy:T,window:1e6},{pattern:/^claude-opus-(4-7|4-6)(?:-\d{8})?(?:\[[^\]]+\])?$/,rate:{input:5,output:25},cachePolicy:T,window:1e6},{pattern:/^claude-opus-4-5(?:-\d{8})?(?:\[[^\]]+\])?$/,rate:{input:5,output:25},cachePolicy:T,window:2e5},{effortChangeKeepsCache:!0,pattern:/^claude-sonnet-5-5(?:-\d{8})?(?:\[[^\]]+\])?$/,rate:{input:2,cacheRead:.1,output:10},cachePolicy:T,window:1e6,effectiveDate:"2026-10-07"},{pattern:/^claude-sonnet-5(?:-\d{8})?(?:\[[^\]]+\])?$/,rate:{input:2,output:10},cachePolicy:T,window:1e6,effectiveDate:"2026-08-10"},{pattern:/^claude-sonnet-4-6(?:-\d{8})?(?:\[[^\]]+\])?$/,rate:{input:3,output:15},cachePolicy:T,window:1e6},{pattern:/^claude-sonnet-4-5(?:-\d{8})?(?:\[[^\]]+\])?$/,rate:{input:3,output:15},cachePolicy:T,window:2e5},{effortChangeKeepsCache:!0,pattern:/^claude-haiku-5-5(?:-\d{8})?(?:\[[^\]]+\])?$/,rate:{input:.1,output:.5},longContext:{threshold:1e5,inputMultiplier:5,outputMultiplier:5},cachePolicy:T,window:1e6,effectiveDate:"2026-10-07"},{pattern:/^claude-haiku-4-5(?:-\d{8})?(?:\[[^\]]+\])?$/,rate:{input:1,output:5},cachePolicy:T,window:2e5},{pattern:/^gpt-6-astra$/,rate:{input:10,cacheWrite30m:12.5,cacheRead:1,output:50},window:105e4,cachePolicy:{kind:"documented",lifetime:"30m",sources:["https://developers.openai.com/api/docs/guides/prompt-caching"]},providers:["openai"],serviceTierMultipliers:{fast:2,priority:2,flex:.5,batch:.5,ultrafast:6},maxPricedContext:272e3,longContext:{threshold:272e3,inputMultiplier:2,outputMultiplier:1.5},bedrock:{prefixes:/^(?:us|global)?$/,regionalMultiplier:1.1,window:105e4,cachePolicy:{kind:"unknown",sources:["https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-astra.html"]},effectiveDate:null}},{pattern:/^gpt-6\.1-sol$/,rate:{input:2,cacheWrite30m:2.5,cacheRead:.1,output:10},window:105e4,cachePolicy:{kind:"documented",lifetime:"30m",sources:["https://developers.openai.com/api/docs/guides/prompt-caching"]},providers:["openai"],serviceTierMultipliers:{fast:2,priority:2,flex:.5,batch:.5,ultrafast:6},maxPricedContext:272e3,longContext:{threshold:272e3,inputMultiplier:2,outputMultiplier:1.5},bedrock:{prefixes:/^(?:us|global)?$/,regionalMultiplier:1.1,window:1e6,cachePolicy:{kind:"documented",lifetime:"30m",sources:["https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-1-sol.html"]},effectiveDate:"2026-09-29"}},{pattern:/^gpt-6\.1-terra$/,rate:{input:1,cacheWrite30m:1.25,cacheRead:.05,output:5},window:105e4,cachePolicy:{kind:"documented",lifetime:"30m",sources:["https://developers.openai.com/api/docs/guides/prompt-caching"]},providers:["openai"],serviceTierMultipliers:{fast:2,priority:2,flex:.5,batch:.5},maxPricedContext:272e3,longContext:{threshold:272e3,inputMultiplier:2,outputMultiplier:1.5},bedrock:{prefixes:/^(?:us|global)?$/,regionalMultiplier:1.1,window:105e4,cachePolicy:{kind:"documented",lifetime:"30m",sources:["https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-1-terra.html"]},effectiveDate:null}},{pattern:/^gpt-6-sol$/,rate:{input:2,cacheWrite30m:2.5,cacheRead:.2,output:10},window:105e4,cachePolicy:{kind:"documented",lifetime:"30m",sources:["https://developers.openai.com/api/docs/guides/prompt-caching"]},providers:["openai"],serviceTierMultipliers:{fast:2,priority:2,flex:.5,batch:.5},maxPricedContext:272e3,longContext:{threshold:272e3,inputMultiplier:2,outputMultiplier:1.5},bedrock:{...D,effectiveDate:"2026-09-22"}},{pattern:/^gpt-6-luna$/,rate:{input:.1,cacheWrite30m:.125,cacheRead:.01,output:.5},window:105e4,cachePolicy:{kind:"documented",lifetime:"30m",sources:["https://developers.openai.com/api/docs/guides/prompt-caching"]},providers:["openai"],serviceTierMultipliers:{fast:2,priority:2,flex:.5,batch:.5},maxPricedContext:272e3,longContext:{threshold:272e3,inputMultiplier:2,outputMultiplier:1.5},bedrock:{...D,effectiveDate:"2026-09-22"}},{pattern:/^gpt-5\.5(?:-2026-04-23)?$/,rate:{input:5,cacheRead:.5,output:30},window:105e4,cachePolicy:{kind:"documented",lifetime:"30m",sources:["https://developers.openai.com/api/docs/guides/prompt-caching"]},providers:["openai"],serviceTierMultipliers:{fast:2.5,priority:2.5,flex:.5,batch:.5},serviceTierBands:{fast:["short"],priority:["short"]},maxPricedContext:272e3,longContext:{threshold:272e3,inputMultiplier:2,outputMultiplier:1.5}},{pattern:/^gpt-5\.4(?:-2026-03-05)?$/,serviceTierRates:{flex:{short:{input:1.25,output:7.5,cacheRead:.13},long:{input:2.5,output:11.25,cacheRead:.25}},batch:{short:{input:1.25,output:7.5,cacheRead:.13},long:{input:2.5,output:11.25,cacheRead:.25}}},rate:{input:2.5,cacheRead:.25,output:15},window:105e4,cachePolicy:{kind:"documented",lifetime:"5m",sources:["https://developers.openai.com/api/docs/guides/prompt-caching"]},providers:["openai"],serviceTierMultipliers:{fast:2,priority:2,flex:.5,batch:.5},serviceTierBands:{fast:["short"],priority:["short"]},maxPricedContext:272e3,longContext:{threshold:272e3,inputMultiplier:2,outputMultiplier:1.5}},{pattern:/^gpt-5\.6(?:-sol)?$/,promotion:{until:"2026-11-21",standard:{input:5,cacheWrite30m:6.25,cacheRead:.5,output:30},note:"OpenAI held gpt-5.6-sol at $4/$20 at least to this date, against a standard $5/$30. Check the published rate: either move the date out, or take the promotion off and use standard."},rate:{input:4,cacheWrite30m:5,cacheRead:.4,output:20},window:272e3,cachePolicy:{kind:"documented",lifetime:"30m",sources:["https://developers.openai.com/api/docs/guides/prompt-caching"]},providers:["openai"],serviceTierMultipliers:{fast:2,priority:2,flex:.5,batch:.5},maxPricedContext:272e3,longContext:{threshold:272e3,inputMultiplier:2,outputMultiplier:1.5},bedrock:{...D,model:"gpt-5.6-sol",effectiveDate:"2026-08-21",profileEffectiveDate:"2026-08-20"}},{pattern:/^gpt-5\.6-terra$/,rate:{input:2,cacheWrite30m:2.5,cacheRead:.2,output:12},window:272e3,cachePolicy:{kind:"documented",lifetime:"30m",sources:["https://developers.openai.com/api/docs/guides/prompt-caching"]},providers:["openai"],serviceTierMultipliers:{fast:2,priority:2,flex:.5,batch:.5},maxPricedContext:272e3,longContext:{threshold:272e3,inputMultiplier:2,outputMultiplier:1.5},bedrock:{...D,effectiveDate:"2026-07-30",profileEffectiveDate:"2026-08-20"}},{pattern:/^gpt-5\.6-luna$/,rate:{input:.2,cacheWrite30m:.25,cacheRead:.02,output:1.2},window:272e3,cachePolicy:{kind:"documented",lifetime:"30m",sources:["https://developers.openai.com/api/docs/guides/prompt-caching"]},providers:["openai"],serviceTierMultipliers:{fast:2,priority:2,flex:.5,batch:.5},maxPricedContext:272e3,longContext:{threshold:272e3,inputMultiplier:2,outputMultiplier:1.5},bedrock:{...D,effectiveDate:"2026-07-30",profileEffectiveDate:"2026-08-20"}}],nr=Rt.flatMap(t=>t.promotion?[{pattern:t.pattern,promo:t.promotion}]:[]),vt="codex-auto-review",rr={[vt]:"gpt-5.4"};var or={"5m":5*6e4,"30m":30*6e4,"1h":60*6e4};var G="…";function Re(t){return!!t&&/^\S{1,200}$/.test(t)}var Tt=200,X=6e3,O=2e3,Ct=/^answer:\d{1,4}$/,Mt=/^prompt:\d{1,4}$/;function Et(t){return t==="prompt"||t==="summary"||typeof t=="string"&&Ct.test(t)||typeof t=="string"&&Mt.test(t)||typeof t=="string"&&t.startsWith("said:")&&Re(t.slice(5))?t:"summary"}function At(t){if(!t||typeof t!="object"||Array.isArray(t))return null;let e=t,n=(d,g)=>typeof d=="string"?q(d,g,G):"",o=d=>typeof d=="number"&&Number.isFinite(d)?d:null,r=n(e.id,O),a=n(e.sessionId,O),i=n(e.turnKey,O),u=n(e.note,X).trim(),l=o(e.at),c=o(e.turnAt);return!r||!a||!i||!u||l===null||c===null?null:{id:r,sessionId:a,turnKey:i,part:Et(e.part),quote:n(e.quote,X),...typeof e.matchQuote=="string"?{matchQuote:n(e.matchQuote,X)}:{},offset:typeof e.offset=="number"&&Number.isFinite(e.offset)&&e.offset>=0?Math.trunc(e.offset):void 0,note:u,headline:n(e.headline,O),sessionTitle:n(e.sessionTitle,O),turnAt:c,at:l}}function N(t){let e=[];if(Array.isArray(t))for(let n of t){let o=At(n);o&&e.push(o)}return e.slice(Math.max(0,e.length-Tt))}function ve(t,e){if(!e||typeof e!="object")return[...t];let n=e;if(n.op==="clear"){let i=typeof n.sessionId=="string"?n.sessionId:"";return i?N(t.filter(u=>u.sessionId!==i)):[...t]}if(n.op==="delete"){let i=typeof n.id=="string"?n.id:"";return i?N(t.filter(u=>u.id!==i)):[...t]}if(n.op!=="write")return[...t];let[o]=N([n.note]);if(!o)return[...t];let r=t.findIndex(i=>i.id===o.id),a=[...t];return r<0?a.push(o):a[r]=o,N(a)}function Se(){return{places:[],at:-1}}function J(t){return t.at>=0&&t.at<t.places.length?t.places[t.at]:null}function Lt(t){return t.at>0}function Pt(t){return t.at>=0&&t.at<t.places.length-1}function ke(t,e){if(!e||J(t)===e)return t;let n=t.places.slice(0,t.at+1);return n.push(e),It({places:n,at:n.length-1})}function Te(t){return Lt(t)?{places:t.places,at:t.at-1}:null}function Ce(t){return Pt(t)?{places:t.places,at:t.at+1}:null}function It(t){if(t.places.length<=50)return t;let e=t.places.length-50;return{places:t.places.slice(e),at:t.at-e}}function _t(t){return/^Mac/.test(t||"")}function Me(t,e){return!t||t.key!=="Enter"||t.altKey||t.shiftKey?!1:_t(e)?!!t.metaKey&&!t.ctrlKey:!!t.ctrlKey&&!t.metaKey}var Nt="`",Vr=Nt.repeat(3);function Ee(t,e){if(t.defaultPrevented||t.isComposing||t.keyCode===229||t.metaKey)return null;if(/^Win/.test(e))return!t.altKey||t.ctrlKey||t.shiftKey?null:t.key==="ArrowLeft"?"goBack":t.key==="ArrowRight"?"goForward":null;if((t.key==="-"||t.code==="Minus")&&t.ctrlKey){if(t.shiftKey&&!t.altKey)return"goForward";if(!t.shiftKey&&t.altKey===!/^Mac/.test(e))return"goBack"}return null}var Z={unit:"hour",count:1},Dt="label",Pe="find",Ie="in",Ot=["both","prompt","summary"],Ae={response:"summary",answer:"summary",reply:"summary",ask:"prompt",me:"prompt"},_e="is",Ft=["input","unread","read","running","warm","active","needsyou","archived","agentrun"],Le={waiting:"input",blocked:"input"},F="active",Wt=[{prefix:"id",field:"session"},{prefix:"session",field:"session"},{prefix:"agent",field:"agent"},{prefix:"title",field:"title"},{prefix:Dt,field:"labels"},{prefix:"cost",field:"cost"},{prefix:"cache-expiry",field:"cache-expiry"},{prefix:_e,field:"status"},{prefix:F,field:"active"}],$t=["cost","cache-expiry"],V="-",Ht=/\s/,Ut=/^(>|<)(\d+(?:\.\d+)?)$/,qt=/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i,Bt=/^(\d+)([hd])$/,Ne="today",Vt=3600*1e3,Gr=24*Vt;function ee(t){let e=t.toLowerCase();if(e===Ne)return{unit:"today"};let n=Bt.exec(e),o=n?Number(n[1]):0;return!n||!Number.isSafeInteger(o)||o<1?null:{unit:n[2]==="h"?"hour":"day",count:o}}function te(t){return t.unit==="today"?Ne:`${t.count}${t.unit==="hour"?"h":"d"}`}function jt(t){let e=qt.exec(t);if(!e)return null;let n=e[2]??"",o=e[3]?Number(e[3]):0;if(!Number.isSafeInteger(o))return null;let r=`${e[1]}${n}`.replace(/^0+/,"");if(!r)return{digits:"0",exponent:0};let a=o-n.length;for(;r.endsWith("0");)r=r.slice(0,-1),a++;return{digits:r,exponent:a}}function Qt(t){let e=[],n="",o=-1,r=!1,a=!1,i=!1,u=l=>{o!==-1&&e.push({text:n,start:o,end:l,quoted:a,quotedHead:i}),n="",o=-1,a=!1,i=!1};for(let l=0;l<t.length;l++){let c=t[l];if(!r&&Ht.test(c)){u(l);continue}if(o===-1&&(o=l,i=c==='"'),c==='"'){if(a=!0,r&&t[l+1]==='"'){n+='"',l++;continue}r=!r;continue}n+=c}return u(t.length),e}function De(t){let e=t.indexOf(":");return e>0?t.slice(0,e).toLowerCase():""}function Kt(t){let e=De(t);return e===Pe||e===Ie}function zt(t){if(t.quotedHead)return null;let e=!t.quotedHead&&t.text.startsWith("-"),n=e?t.text.slice(1):t.text,o=De(n);if(o!=="session"&&o!=="id")return null;let r=n.slice(n.indexOf(":")+1),a=/^(claude|codex):(.+)$/i.exec(r),i=a?a[1].toLowerCase():"any",u=a?a[2]:r,l={any:new Set,claude:new Set,codex:new Set},c=!u||/[\s:/\\]/.test(u);return c||l[i].add(u),{field:"session",needle:r,identities:l,...o==="id"?{shorthand:!0}:{},...e?{negated:!0}:{},...c?{invalid:!0}:{}}}function Oe(t){return ne(t).terms.some(e=>e.invalid)?"Use session IDs or prefixes of at least eight characters. Join positive selectors with OR.":null}function ne(t){let e={terms:[],find:[],where:"both",unknownWhere:[],unknownIs:[]},n=!1,o=Qt(t),r=o.map(zt),a=new Set;for(let u=0;u<o.length;u++){if(o[u].text!=="OR"||o[u].quoted)continue;let l=u-1,c=u+1;for(;l>=0&&o[l].text==="OR"&&!o[l].quoted;)l--;for(;c<o.length&&o[c].text==="OR"&&!o[c].quoted;)c++;if(!r[l]&&!r[c])continue;if(l!==u-1||c!==u+1||!r[l]||!r[c]||r[l].negated||r[c].negated||r[l].invalid||r[c].invalid){e.terms.push({field:"session",needle:"",invalid:!0}),a.add(u);continue}let d=r[l],g=r[c];g.shorthand&&(d.shorthand=!0);for(let p of["any","claude","codex"])for(let f of g.identities[p])d.identities[p].add(f);r[c]=d,a.add(l),a.add(u)}for(let u=0;u<o.length;u++){if(a.has(u))continue;if(r[u]){e.terms.push(r[u]);continue}let{text:l,quoted:c,quotedHead:d}=o[u];if(!l||!d&&l===V||!d&&l.startsWith(V+V))continue;let g=!d&&l[0]===V&&!Kt(l.slice(1)),p=g?l.slice(1):l,f=g?{negated:!0}:{},m=p.toLowerCase(),R=p.indexOf(":"),E=R>0?p.slice(0,R).toLowerCase():"",v=R>0?p.slice(R+1):"",w=v.toLowerCase();if(E===Pe){n=!0,w&&e.find.push(w);continue}if(E===Ie){let x=Ot.find(b=>b===w)||(Object.prototype.hasOwnProperty.call(Ae,w)?Ae[w]:void 0);x?e.where=x:w&&e.unknownWhere.push(w);continue}if(E===F){let x=c||!v?null:ee(v);x?e.terms.push({field:"active",needle:te(x),activeWindow:x,...f}):v&&e.terms.push({field:"active",needle:v,...f});continue}if(E===_e){let x=Ft.find(b=>b===w)||(Object.prototype.hasOwnProperty.call(Le,w)?Le[w]:void 0);x?e.terms.push({field:"status",needle:x,...f}):w&&e.unknownIs.push(l);continue}let k=Wt.find(x=>x.prefix===E&&!(d&&x.field==="session"));if(k){if($t.includes(k.field)){let x=c?null:Ut.exec(v),b=x?jt(x[2]):null;e.terms.push({field:k.field,needle:v,...f,...x&&b?{comparison:{operator:x[1],threshold:b}}:{}});continue}v&&e.terms.push({field:k.field,needle:k.field==="labels"?v:w,...f});continue}n?e.find.push(m):e.terms.push({field:"title",needle:m,plain:!0,...f})}let i=e.terms.filter(u=>u.field==="session"&&u.shorthand&&!u.negated&&!u.invalid);if(i.length>1){let u=i[0];for(let l of i.slice(1))for(let c of["any","claude","codex"])for(let d of l.identities[c])u.identities[c].add(d);e.terms=e.terms.filter(l=>!i.includes(l)||l===u)}return e}function Fe(t,e,n,o){return t!==!1&&!e&&(n||o)?!1:t}var We={productName:"Arc",repositoryName:"arc",publisher:"glin",extensionName:"arc",extensionId:"glin.arc",commandPrefix:"arc",settingsSection:"arc",panelType:"arc.panel",panelStateKey:"arc.panelState",homeDirectory:".arc",snapshotsDirectory:"snapshots",environmentPrefix:"ARC_",visualizationScheme:"arc-visualization:",sessionScheme:"arc-session:",cliPackageName:"@glin/arc",cliExecutable:"arc",vsixFileName:"arc.vsix",baselineScheme:"arc-baseline",patchScheme:"arc-patch"};function Yt(t){return t.length>0&&!/[\s\u0000-\u001f\u007f-\u009f\\/?#]/u.test(t)}function $e(t){let e=t.trimStart(),n=We.sessionScheme;if(e.slice(0,n.length).toLowerCase()!==n)return{kind:"other"};try{let o=decodeURIComponent(e.slice(n.length));return Yt(o)?{kind:"session",session:o}:{kind:"invalid"}}catch{return{kind:"invalid"}}}function Gt(t,e){if(!t.trim())return!0;let n=p=>{throw new Error(`The menu stand-in cannot read the when clause "${t}": ${p}.`)},o=[],r=/\s*('[^']*'|==|!=|&&|\|\||[!()]|[A-Za-z_][\w.:-]*)/y;for(;r.lastIndex<t.length&&t.slice(r.lastIndex).trim();){let p=r.lastIndex,f=r.exec(t);f||n(`unsupported text at "${t.slice(p).trim()}"`),o.push(f[1])}let a=p=>p!==void 0&&/^[A-Za-z_]/.test(p),i=0,u=p=>p?.startsWith("'")?p.slice(1,-1):(a(p)||n(`a comparison has no value after "${o[i-2]} ${o[i-1]}"`),p==="true"?!0:p==="false"?!1:p),l=()=>{let p=o[i++];if(p==="("){let m=d();return o[i++]!==")"&&n("a parenthesis is not closed"),m}if(p==="!")return!l();a(p)||n(p===void 0?"it ends early":`unexpected "${p}"`);let f=e[p];if(o[i]==="=="||o[i]==="!="){let m=o[i++]==="==",R=u(o[i++]);return(f===R||String(f)===String(R))===m}return!!f},c=()=>{let p=l();for(;o[i]==="&&";)i++,p=l()&&p;return p},d=()=>{let p=c();for(;o[i]==="||";)i++,p=c()||p;return p},g=d();return i<o.length&&n(`unexpected "${o[i]}"`),g}function Xt(t,e){let n=new Map;for(let o of t){if(!Gt(o.when,e))continue;let[r,a]=o.group.split("@"),i=n.get(r)??[];i.push({order:Number(a)||0,entry:o}),n.set(r,i)}return[...n.keys()].sort((o,r)=>o==="navigation"?-1:r==="navigation"?1:o<r?-1:o>r?1:0).map(o=>n.get(o).sort((r,a)=>r.order-a.order).map(r=>r.entry))}function Jt(t){let e=[];for(let n=t;n;n=n.parentElement){let o=n.dataset?.vscodeContext;if(o)try{e.push(JSON.parse(o))}catch{}}return Object.assign({},...e.reverse())}function He(t,e,n){let o=t.defaultView,r=null;o.addEventListener("contextmenu",a=>{let i=a.target instanceof Element?a.target:null;if(!i||i.closest(".demo-menu"))return;r?.(!1);let u=Jt(i),l=Xt(e,u);if(!l.length)return;a.preventDefault();let c=t.activeElement instanceof HTMLElement?t.activeElement:null,d=t.createElement("div");d.className="demo-menu",d.setAttribute("role","menu"),l.forEach((b,U)=>{if(U){let P=t.createElement("div");P.setAttribute("role","separator"),d.append(P)}for(let P of b){let _=t.createElement("button");_.type="button",_.setAttribute("role","menuitem"),_.tabIndex=-1,_.textContent=P.title,_.addEventListener("click",()=>{r?.(!0),n(P.command,u)}),d.append(_)}}),t.body.append(d);let g=Array.from(d.querySelectorAll('[role="menuitem"]')),p=i.getBoundingClientRect(),f=a.clientX===0&&a.clientY===0,m=f?p.left:a.clientX,R=f?p.bottom:a.clientY,E=d.offsetWidth,v=d.offsetHeight;d.style.left=`${Math.max(0,m+E>o.innerWidth?o.innerWidth-E:m)}px`,d.style.top=`${Math.max(0,R+v>o.innerHeight?R-v:R)}px`;let w=b=>{(!(b.target instanceof Node)||!d.contains(b.target))&&r?.(!1)},k=b=>{d.remove(),t.removeEventListener("pointerdown",w,!0),o.removeEventListener("blur",x),r=null,b&&c?.isConnected&&c.focus()},x=()=>k(!1);r=k,t.addEventListener("pointerdown",w,!0),o.addEventListener("blur",x),d.addEventListener("keydown",b=>{let U=g.indexOf(t.activeElement),P=b.key==="ArrowDown"?(U+1)%g.length:b.key==="ArrowUp"?(U-1+g.length)%g.length:b.key==="Home"?0:b.key==="End"?g.length-1:-1;P>=0?(b.preventDefault(),g[P].focus()):(b.key==="Escape"||b.key==="Tab")&&(b.preventDefault(),k(!0))}),g[0].focus()})}var re=[["toolCallTokens","Tool calls"],["toolResultTokens","Tool results"],["attachmentTokens","Attachments"],["assistantMessageTokens","Assistant messages"],["userMessageTokens","User messages"],["redirectedContextTokens","Redirected context"],["unattributedTokens","Unattributed"]],Zt=new Map([["prompt_snapshot","System prompt"],["skill_listing","Skills"],["instructions","Memory files"],["mcp_instructions_delta","MCP server instructions"]]);function Ue(t){return t==="pending-tools"||t==="awaiting-measurement"}function C(t){return typeof t=="string"&&t.length<=256*2&&Array.from(t).length<=256}function y(t){return typeof t=="number"&&Number.isSafeInteger(t)&&t>=0}function W(t){if(!t||typeof t!="object")return!1;let e=t;return C(e.session)&&!!e.session&&C(e.model)&&C(e.source)&&(e.provider==="claude"||e.provider==="codex")&&y(e.generation)&&y(e.request)}function j(t,e="unavailable"){return{...t,status:e,capturedAt:Date.now(),measurement:"provider-estimate",used:null,capacity:null,remaining:null,reserve:null,categories:[]}}function qe(t,e,n=Date.now()){if(e.provider==="codex")return nn(t,e,n);let o=j(e);if(!W(e)||e.provider!=="claude"||!t||typeof t!="object")return o;let r=t;if(!y(r.totalTokens)||!y(r.rawMaxTokens)||r.rawMaxTokens===0||!C(r.model)||!Array.isArray(r.categories)||r.categories.length>32)return o;let a=[],i=new Set,u=null,l=null;for(let f of r.categories){if(!f||typeof f!="object")return o;let m=f;if(!C(m.name)||!m.name.trim()||!y(m.tokens)||typeof m.kind!="string"||!["used","free","buffer","deferred"].includes(m.kind))return o;let R=m.name;if(i.has(R))return o;i.add(R),m.kind==="used"&&a.push({key:R,name:m.name,tokens:m.tokens,relationship:"used"}),m.kind==="free"&&(u=(u??0)+m.tokens),m.kind==="buffer"&&(l=(l??0)+m.tokens)}let c=a.reduce((f,m)=>f+m.tokens,0);if(!y(c)||u!==null&&!y(u)||l!==null&&!y(l))return o;a.sort((f,m)=>m.tokens-f.tokens);let d=a.find(f=>f.key==="Messages"),g=r.messageBreakdown,p;return d&&g&&typeof g=="object"&&(p=en(g,d.tokens,a)),{...e,model:r.model,capturedAt:n,measurement:"provider-estimate",status:c===r.totalTokens?"available":"mismatch",used:r.totalTokens,capacity:r.rawMaxTokens,remaining:u,reserve:l,categories:a,...p?{messageBreakdown:p}:{}}}function en(t,e,n){let o=[];for(let[l,c]of re){let d=t[l];if(!y(d))return;o.push({key:l,name:c,tokens:d})}let r=o.find(l=>l.key==="attachmentTokens"),a=tn(t.attachmentsByType,r.tokens,n);if(a===void 0)return;let i=o.reduce((l,c)=>l+c.tokens,0);if(!y(i))return;if(i===e)return o;r.tokens-=a;let u=i-a;if(!(u>e)&&!o.every(l=>l.key==="unattributedTokens"||l.tokens===0))return o.find(l=>l.key==="unattributedTokens").tokens+=e-u,o}function tn(t,e,n){if(t===void 0)return 0;if(!Array.isArray(t)||t.length>64)return;let o=new Set,r=0,a=0;for(let i of t){if(!i||typeof i!="object")return;let{name:u,tokens:l}=i;if(!C(u)||!y(l)||o.has(u))return;o.add(u),r+=l;let c=Zt.get(u);c&&n.some(d=>d.key===c)&&(a+=l)}return y(r)&&r===e?a:void 0}function nn(t,e,n){let o=j(e);if(!W(e)||!t||typeof t!="object")return o;let r=t;if(r.kind==="codex-context-unavailable")return r.session!==e.session||!C(r.model)||!r.model||e.model&&r.model!==e.model||!Ue(r.reason)?o:{...o,capturedAt:n,reason:r.reason};if(r.kind!=="codex-retained-context"||!["request","retained-estimate"].includes(String(r.basis))||r.session!==e.session||!C(r.model)||!r.model||e.model&&r.model!==e.model||!y(r.used)||!y(r.capacity)||!r.capacity||!Array.isArray(r.categories)||!r.categories.length||r.categories.length>32)return o;let a={...e,model:r.model,capturedAt:n,measurement:"local-estimate",basis:r.basis,status:r.categories.reduce((i,u)=>i+(u?.tokens??NaN),0)===r.used?"available":"mismatch",used:r.used,capacity:r.capacity,remaining:Math.max(0,r.capacity-r.used),reserve:null,categories:r.categories.map(i=>({key:i?.key,name:i?.name,tokens:i?.tokens,relationship:i?.relationship}))};return I(a)?(a.categories.sort((i,u)=>u.tokens-i.tokens),a):o}function I(t){if(!W(t))return!1;let e=t;if(!["loading","available","mismatch","unavailable","stale"].includes(e.status)||e.reason!==void 0&&(e.status!=="unavailable"||(e.provider==="codex"?!Ue(e.reason):e.reason!=="claude-no-live-session"))||!y(e.capturedAt)||!["provider-estimate","local-estimate"].includes(e.measurement)||e.measurement==="local-estimate"&&(e.provider!=="codex"||e.reserve!==null)||e.measurement==="local-estimate"&&!["request","retained-estimate"].includes(String(e.basis))||![e.used,e.capacity,e.remaining,e.reserve].every(a=>a===null||y(a))||!Array.isArray(e.categories)||e.categories.length>32)return!1;let n=new Set;for(let a of e.categories){if(!a||!C(a.key)||!C(a.name)||!a.name.trim()||!y(a.tokens)||a.relationship!=="used"||n.has(a.key))return!1;n.add(a.key)}let o=e.status==="available"||e.status==="mismatch";if(e.messageBreakdown!==void 0){if(e.provider!=="claude"||!o||!Array.isArray(e.messageBreakdown)||e.messageBreakdown.length!==re.length)return!1;let a=new Set;for(let u of e.messageBreakdown){if(!u||!re.some(([l,c])=>u.key===l&&u.name===c)||!y(u.tokens)||a.has(u.key))return!1;a.add(u.key)}let i=e.messageBreakdown.reduce((u,l)=>u+l.tokens,0);if(!y(i)||i!==e.categories.find(u=>u.key==="Messages")?.tokens)return!1}let r=e.categories.reduce((a,i)=>a+i.tokens,0);return o&&(e.used===null||!e.capacity||!y(r)||e.status==="available"!=(r===e.used))||!o&&(e.categories.length||e.used!==null||e.capacity!==null)?!1:new TextEncoder().encode(JSON.stringify({type:"contextDetail",detail:e})).length<=32768}function rn(t){if(!/^https?:\/\/[^\s/\\?#]+(?:[/?#]|$)/i.test(t)||/[\u0000-\u001f\u007f\\]/.test(t))return!1;try{let e=new URL(t);return(e.protocol==="http:"||e.protocol==="https:")&&!!e.hostname}catch{return!1}}function Be(t){if(!t||typeof t!="object")return null;let e=t;return e.kind==="url"&&typeof e.url=="string"&&rn(e.url)?{kind:"url",url:e.url}:(e.kind==="path"||e.kind==="fileCitation")&&typeof e.path=="string"&&e.path?{kind:e.kind,path:e.path}:null}var Ve=["latest","cost-desc","cost-asc","needs-you"];var je=40,Qe=200,mo={taken:"A view already has that name. Choose another name.",unnamed:"A view needs a name. Type one to save it.",limit:`A name is cut to ${je} characters. Two names that agree that far are one view.`};var oe=Qe;var on="needs-you",sn="is:needsyou -is:archived -is:agentrun",an=["All sessions","Running","Active","Unread","Needs input","Needs you","Custom"],To=new Set(an.map(t=>fn(t))),Ke=["running","active","unread","input"],ln=["1h","3h","6h","12h","today","2d"],un="1h";function cn(t){return ee(t)??Z}var $="-is:archived -is:agentrun",ze={running:`is:running ${$}`,active:`${F}:${un} ${$}`,unread:`is:unread ${$}`,input:`is:input ${$}`};function dn(t,e=Z){return t==="active"?`${F}:${te(e)} ${$}`:ze[t]}var Co=oe+Math.max(sn.length,...Ke.map(t=>ze[t].length),...ln.map(t=>dn("active",cn(t)).length))+1;function pn(t){return Ke.includes(t)}function Ye(t){return pn(t)||t===on}function fn(t){return t.toLocaleLowerCase()}var gn=5,hn=1048576;function Ge(...t){let e=new Map;for(let n of t)if(Array.isArray(n))for(let o of n){if(!o||typeof o!="object")continue;let r=o;if(typeof r.id!="string"||!r.id||r.id.length>200||typeof r.source!="string"||r.source.length>200||typeof r.text!="string"||r.text.length>hn||!Number.isSafeInteger(r.order)||r.order<1||!Number.isSafeInteger(r.revision)||r.revision<0)continue;let a={id:r.id,order:r.order,source:r.source,revision:r.revision,text:r.text};typeof r.owner=="string"&&r.owner.length<=200&&Number.isSafeInteger(r.ownerRevision)&&r.ownerRevision>0&&(a.owner=r.owner,a.ownerRevision=r.ownerRevision,r.accepted===!0&&(a.accepted=!0)),r.setup&&(r.setup.agent==="claude"||r.setup.agent==="codex")&&["model","effort","permissionMode"].every(u=>typeof r.setup[u]=="string"&&r.setup[u].length<=200)&&(a.setup={agent:r.setup.agent,model:r.setup.model,effort:r.setup.effort,permissionMode:r.setup.permissionMode,source:r.setup.source==="inherited"||r.setup.source==="recent"?r.setup.source:"custom"});let i=e.get(r.id);if(i&&(i.order!==a.order||i.source!==a.source||i.revision!==a.revision||i.text!==a.text||i.setup&&a.setup&&["agent","model","effort","permissionMode","source"].some(u=>i.setup[u]!==a.setup[u])))throw new Error("The saved prompt conflicts with another copy.");(!i||(a.ownerRevision??0)>(i.ownerRevision??0))&&e.set(r.id,a)}return[...e.values()].sort((n,o)=>n.order-o.order||(n.id<o.id?-1:n.id>o.id?1:0)).slice(-gn)}var Xe=64,yn=200;var bn=["claude","codex"];function se(t){return typeof t=="string"&&t.length<=yn?t:null}function Je(t){if(!t||typeof t!="object")return null;let e=t,n=bn.find(i=>i===e.agent),o=se(e.model),r=se(e.effort),a=se(e.permissionMode);return!n||o===null||r===null||a===null?null:{agent:n,model:o,effort:r,permissionMode:a}}function tt(t){return typeof t=="object"&&t!==null&&!Array.isArray(t)}function Ze(t){return Number.isSafeInteger(t)&&t>=0}function nt(t){return Array.isArray(t)&&t.every(e=>typeof e=="string")}function et(t){return t===void 0||tt(t)&&Ze(t.head)&&Ze(t.tail)&&nt(t.ids)}function ie(t){return t===void 0?!0:tt(t)&&Number.isSafeInteger(t.revision)&&(t.base===null||Number.isSafeInteger(t.base))&&(t.sessionsBase===void 0||t.sessionsBase===null||Number.isSafeInteger(t.sessionsBase))&&et(t.sessionOrder)&&et(t.railOrder)&&(t.statsRemoved===void 0||nt(t.statsRemoved))}var xn=["compact","one-column","two-columns"],wn=["above","below"];function ae(t){return typeof t=="string"&&xn.includes(t)}function le(t){return typeof t=="string"&&wn.includes(t)}function Rn(t){if(!t||typeof t!="object")return null;let e=t;return!Number.isSafeInteger(e.revision)||e.revision<0||!Number.isFinite(e.since)||e.since<0||!Array.isArray(e.read)||e.read.length>2e3||e.read.some(n=>typeof n!="string")||!e.readTo||typeof e.readTo!="object"||Array.isArray(e.readTo)||Object.values(e.readTo).some(n=>!Number.isFinite(n)||n<0)||!Array.isArray(e.agentRead)||e.agentRead.length>2e3||e.agentRead.some(n=>!Array.isArray(n)||n.length!==2||n.some(o=>typeof o!="string"||!o))?null:{revision:e.revision,read:[...e.read],readTo:{...e.readTo},since:e.since,agentRead:e.agentRead.map(([n,o])=>[n,o])}}function vn(t){if(!t||typeof t!="object")return null;let e=t;if(typeof e.id!="string"||!e.id||e.id.length>128||!Number.isSafeInteger(e.observedRevision)||e.observedRevision<0)return null;if(e.action==="reset")return Number.isFinite(e.since)&&e.since>=0?{id:e.id,observedRevision:e.observedRevision,action:"reset",since:e.since}:null;if(e.action!=="turn"&&e.action!=="session")return null;let n=e.target;return!n||typeof n.sessionId!="string"||!n.sessionId||!Number.isFinite(n.startedAt)||n.startedAt<0||n.promptId!==void 0&&(typeof n.promptId!="string"||!n.promptId)||typeof e.read!="boolean"||e.action==="session"&&(!Number.isFinite(e.newestAt)||e.newestAt<e.target.startedAt)?null:structuredClone(e)}var Sn={readerDocument:!0,readerReadAdmission:!0,readState:!0,applySessionFilter:!0,health:!0,visibility:!0,queryContext:!0,startupProgress:!0,contextDetail:!0,focusProjectSpend:!0,openLauncher:!0,labelEditor:!0,labelsChanged:!0,openLabelEditor:!0,showSessionDetails:!0,openViewEditor:!0,openSessionRename:!0,sessionRenameResult:!0,focusComposer:!0,pathCompletion:!0,insertPrompt:!0,fileStaging:!0,fileStagingRejected:!0,usage:!0,askRejected:!0,projectSpend:!0,layout:!0,live:!0,activity:!0,selection:!0,rail:!0,openPick:!0,takeDraft:!0,takeQueuedDraft:!0,promptRecovery:!0,requestPromptRecovery:!0,restoreDraft:!0,notes:!0,openComment:!0,sendSelectedText:!0,setRead:!0,forgetState:!0,setSessionRead:!0,setSessionArchived:!0,setSessionPinned:!0,setSessionTurnsOpen:!0,setComposerHidden:!0,results:!0,render:!0};function h(t){return t!==null&&typeof t=="object"&&!Array.isArray(t)?t:null}function s(t){return typeof t=="string"}function A(t){return typeof t=="number"&&Number.isFinite(t)}function kn(t){return s(t)&&Object.prototype.hasOwnProperty.call(Sn,t)}function ue(t){return t===void 0||s(t)}function L(t){return Array.isArray(t)&&t.every(e=>h(e)!==null)}function H(t){return Array.isArray(t)&&t.every(s)}function ce(t){let e=h(t);return!!e&&s(e.name)&&A(e.count)&&s(e.countName)}function Tn(t){let e=h(t);return ce(t)&&typeof e?.applied=="boolean"}function Cn(t){let e=h(t);return!!e&&s(e.id)&&e.id!==""&&s(e.name)&&s(e.query)&&typeof e.archived=="boolean"}function de(t){return Array.isArray(t)&&t.every(Cn)}function Mn(t){let e=h(t);return!!e&&s(e.id)&&e.id!==""&&s(e.name)&&s(e.query)&&Ve.includes(e.sort)&&(e.lens===void 0||e.lens===null||Ye(e.lens))}function pe(t){return Array.isArray(t)&&t.every(Mn)}function ot(t){let e=h(t);return!!e&&s(e.provisional)&&s(e.durable)}function En(t){let e=h(t);return!!e&&s(e.id)&&s(e.label)&&s(e.name)&&A(e.size)&&(e.preview===null||s(e.preview))&&s(e.kind)&&s(e.stem)&&s(e.ext)&&s(e.sizeLabel)&&ue(e.removeLabel)&&ue(e.removeName)&&ue(e.removeControl)}function An(t){let e=h(t);return!!e&&s(e.name)&&typeof e.directory=="boolean"&&s(e.label)&&s(e.accessibleName)&&s(e.completion)}function Ln(t){let e=h(t);return!!e&&(e.kind==="prompt"||e.kind==="compact")&&(e.state==="sent"||e.state==="running"||e.state==="failed"||e.state==="done"||e.state==="interrupted")&&(e.tone==="running"||e.tone==="failed"||e.tone==="done"||e.tone==="interrupted")&&s(e.relative)&&s(e.absolute)&&s(e.agent)&&s(e.model)&&(e.speed===void 0||e.speed===null||s(e.speed))&&s(e.label)&&s(e.headline)&&s(e.status)&&s(e.reply)&&A(e.at)&&(e.since===null||A(e.since))&&s(e.dismissLabel)&&s(e.dismissName)&&s(e.dismissControl)&&s(e.restoreLabel)&&s(e.restoreName)&&s(e.restoreControl)&&s(e.reason)&&Array.isArray(e.files)&&e.files.every(En)}function S(t,e){return typeof t=="string"?t:e}function st(t,e){return typeof t=="number"&&Number.isFinite(t)?t:e}var Pn=24,In=8,_n=1e6;function Nn(t){let e=Array.isArray(t.types)?t.types.filter(s).slice(0,Pn).map(o=>o.slice(0,120)):[],n=Array.isArray(t.values)?t.values.flatMap(o=>{let r=h(o);return r&&s(r.type)&&s(r.data)&&r.data.length<=_n?[{type:r.type.slice(0,120),data:r.data}]:[]}).slice(0,In):[];return{types:e,values:n}}function it(t){let e=h(t);return e?e.kind==="row"&&s(e.key)?{kind:"row",key:e.key}:e.kind==="custom"&&s(e.agent)&&s(e.model)&&s(e.effort)&&s(e.permissionMode)?{kind:"custom",agent:e.agent,model:e.model,effort:e.effort,permissionMode:e.permissionMode}:null:null}function Dn(t){let e=h(t);if(!e)return null;if(e.decision==="allow")return{decision:"allow"};if(e.decision==="deny"&&s(e.reason))return{decision:"deny",reason:e.reason};if(e.decision==="answer"){let n=h(e.answers);if(!n)return null;let o={};for(let[r,a]of Object.entries(n)){let i=h(a);if(!i||!Array.isArray(i.labels)||!i.labels.every(s)||!s(i.written))return null;o[r]={labels:[...i.labels],written:i.written}}return{decision:"answer",answers:o}}return null}function at(t){let e=h(t);if(!e)return null;switch(e.type){case"applySessionFilter":return Object.keys(e).sort().join(",")==="deadline,query,request,type"&&s(e.request)&&e.request.length>0&&e.request.length<=128&&s(e.query)&&e.query.length<=oe&&!Oe(e.query)&&A(e.deadline)?{type:"applySessionFilter",request:e.request,query:e.query,deadline:e.deadline}:null;case"health":return Number.isSafeInteger(e.sequence)&&e.sequence>0?{type:"health",sequence:e.sequence}:null;case"visibility":return typeof e.visible=="boolean"&&Number.isSafeInteger(e.revision)&&e.revision>=0?{type:"visibility",visible:e.visible,revision:e.revision}:null;case"queryContext":return e.queryContext!==void 0&&On(e.queryContext)?{type:"queryContext",queryContext:e.queryContext}:null;case"startupProgress":return(e.complete===void 0||typeof e.complete=="boolean")&&(e.failed===void 0||typeof e.failed=="boolean")&&(e.held===void 0||typeof e.held=="boolean")&&Number.isSafeInteger(e.generation)&&Number.isSafeInteger(e.sequence)&&s(e.epoch)&&Number.isSafeInteger(e.completed)&&Number.isSafeInteger(e.known)&&e.generation>=0&&e.sequence>=0&&e.completed>=0&&e.known>=e.completed?e:null;case"focusProjectSpend":return{type:"focusProjectSpend"};case"openLauncher":return{type:"openLauncher",custom:e.custom===!0};case"labelEditor":return s(e.session)&&s(e.heading)&&Array.isArray(e.rows)&&e.rows.every(Tn)?{type:"labelEditor",session:e.session,heading:e.heading,rows:e.rows}:null;case"labelsChanged":return s(e.session)?{type:"labelsChanged",session:e.session}:null;case"openLabelEditor":return s(e.session)?{type:"openLabelEditor",session:e.session}:null;case"showSessionDetails":return s(e.session)&&e.session.length>0?{type:"showSessionDetails",session:e.session}:null;case"openViewEditor":return s(e.view)&&(e.mode==="rename"||e.mode==="delete")?{type:"openViewEditor",view:e.view,mode:e.mode}:null;case"openSessionRename":return s(e.session)&&e.session.length>0&&s(e.title)?{type:"openSessionRename",session:e.session,title:e.title}:null;case"sessionRenameResult":return s(e.session)&&e.session.length>0&&Number.isSafeInteger(e.request)&&s(e.title)&&s(e.error)?{type:"sessionRenameResult",session:e.session,request:e.request,title:e.title,error:e.error}:null;case"focusComposer":return s(e.session)?{type:"focusComposer",session:e.session}:null;case"contextDetail":if(e.detail&&typeof e.detail=="object"&&"messageBreakdown"in e.detail&&!I(e.detail)){let{messageBreakdown:n,...o}=e.detail;if(I(o))return{type:"contextDetail",detail:o}}return I(e.detail)?{type:"contextDetail",detail:e.detail}:W(e.detail)?{type:"contextDetail",detail:j({session:e.detail.session,provider:e.detail.provider,model:e.detail.model,source:e.detail.source,generation:e.detail.generation,request:e.detail.request})}:null;case"pathCompletion":return s(e.session)&&A(e.request)&&s(e.token)&&A(e.caret)&&Array.isArray(e.rows)&&e.rows.every(An)?{type:"pathCompletion",session:e.session,request:e.request,token:e.token,caret:e.caret,rows:e.rows}:null;case"insertPrompt":return s(e.session)&&s(e.text)?{type:"insertPrompt",session:e.session,text:e.text}:null;case"fileStaging":return s(e.session)?{type:"fileStaging",session:e.session,token:S(e.token,""),pending:e.pending===!0,...typeof e.count=="number"&&Number.isInteger(e.count)&&e.count>0?{count:e.count}:{}}:null;case"fileStagingRejected":return s(e.session)&&s(e.token)?{type:"fileStagingRejected",session:e.session,token:e.token}:null;case"usage":return{type:"usage",usage:e.usage};case"askRejected":return s(e.session)&&s(e.id)?{type:"askRejected",session:e.session,id:e.id}:null;case"projectSpend":return{type:"projectSpend",projectSpend:e.projectSpend};case"layout":{let n=h(e.layout);return n&&ae(n.cardLayout)&&le(n.promptPosition)?{type:"layout",layout:{cardLayout:n.cardLayout,promptPosition:n.promptPosition}}:null}case"live":return s(e.session)&&Array.isArray(e.live)&&e.live.every(Ln)?{type:"live",session:e.session,live:e.live}:null;case"activity":return L(e.cards)?{type:"activity",cards:e.cards}:s(e.session)?{type:"activity",session:e.session,card:e.card}:null;case"selection":return L(e.cards)&&L(e.sessions)&&L(e.rail)&&h(e.stats)!==null&&H(e.replaces)?e:null;case"rail":{let n=h(e.stats),o=e.sessionAdoptions===void 0?[]:e.sessionAdoptions;return L(e.rail)&&n!==null&&Array.isArray(e.labels)&&e.labels.every(ce)&&de(e.views)&&pe(e.railFilters)&&Array.isArray(o)&&o.every(ot)&&H(e.hidden)&&H(e.pinnedTop)&&ie(e.rows)?{type:"rail",rail:e.rail,stats:n,labels:e.labels,views:e.views,railFilters:e.railFilters,sessionAdoptions:o,hidden:e.hidden,pinnedTop:e.pinnedTop,...e.rows===void 0?{}:{rows:e.rows}}:null}case"openPick":return s(e.control)?{type:"openPick",control:e.control}:null;case"takeDraft":return s(e.session)&&s(e.text)?{type:"takeDraft",session:e.session,text:e.text}:null;case"takeQueuedDraft":return s(e.session)&&s(e.text)&&Number.isSafeInteger(e.revision)&&e.revision>=0&&s(e.value)?{type:"takeQueuedDraft",session:e.session,text:e.text,revision:e.revision,value:e.value}:null;case"promptRecovery":try{return{type:"promptRecovery",submittedPrompts:Ge(e.submittedPrompts)}}catch{return null}case"requestPromptRecovery":return s(e.request)?{type:"requestPromptRecovery",request:e.request}:null;case"restoreDraft":return s(e.session)&&s(e.text)&&typeof e.revision=="number"?{type:"restoreDraft",session:e.session,text:e.text,revision:e.revision,...s(e.notice)&&e.notice?{notice:e.notice}:{}}:null;case"notes":return{type:"notes",comments:e.comments};case"openComment":return s(e.key)?{type:"openComment",key:e.key}:null;case"sendSelectedText":return s(e.key)&&e.key.length>0&&typeof e.copyLabels=="boolean"?{type:"sendSelectedText",key:e.key,copyLabels:e.copyLabels}:null;case"readerDocument":return[e.readerPageId,e.documentId,e.challenge].every(n=>typeof n=="string"&&/^[a-f0-9]{32}$/.test(n))?e:null;case"readerReadAdmission":return s(e.id)&&e.id.length<=128&&typeof e.admitted=="boolean"?{type:"readerReadAdmission",id:e.id,admitted:e.admitted}:null;case"readState":{let n=Rn(e.state);return n?{type:"readState",state:n}:null}case"setRead":return s(e.key)?{type:"setRead",key:e.key,read:e.read===!0}:null;case"forgetState":return typeof e.since=="number"?{type:"forgetState",since:e.since}:null;case"setSessionRead":return s(e.session)?{type:"setSessionRead",session:e.session,read:e.read===!0}:null;case"setSessionArchived":return s(e.session)?{type:"setSessionArchived",session:e.session,archived:e.archived===!0}:null;case"setSessionPinned":return s(e.session)?{type:"setSessionPinned",session:e.session,pinned:e.pinned===!0}:null;case"setSessionTurnsOpen":return s(e.session)?{type:"setSessionTurnsOpen",session:e.session,open:e.open===!0}:null;case"setComposerHidden":return{type:"setComposerHidden",hidden:e.hidden===!0};case"results":return s(e.query)&&s(e.scope)?{type:"results",query:e.query,hits:e.hits,scope:e.scope}:null;case"render":{let n=e.sessionAdoptions;return L(e.cards)&&L(e.sessions)&&L(e.rail)&&h(e.stats)!==null&&H(e.hidden)&&H(e.pinnedTop)&&L(e.comments)&&Array.isArray(e.labels)&&e.labels.every(ce)&&de(e.views)&&pe(e.railFilters)&&Array.isArray(e.iconFonts)&&e.iconFonts.every(s)&&Array.isArray(n)&&n.every(ot)&&ie(e.rows)?e:null}default:return null}}function On(t){if(t===void 0)return!0;let e=h(t);return!!e&&["complete","incomplete","unavailable"].includes(String(e.coverage))&&s(e.scope)&&s(e.revision)&&Array.isArray(e.identities)&&e.identities.every(n=>{let o=h(n);return!!o&&s(o.sessionId)&&s(o.agent)})}var lt=200,ut=256,Fn=1e6;function Wn(t){let e=h(t);if(!e)return null;let n=Object.entries(e);if(n.length>lt)return null;for(let[o,r]of n)if(o.length>ut||!/^(?:key|view):./.test(o)||!Number.isSafeInteger(r)||r<1||r>Fn)return null;return Object.fromEntries(n)}function $n(t){return!Array.isArray(t)||t.length>lt?null:t.every(e=>typeof e=="string"&&e.length>0&&e.length<=ut)?t:null}function ct(t){let e=h(t);if(!e)return null;switch(e.type){case"readerRead":{let n=vn(e.operation);return n?{type:"readerRead",operation:n}:null}case"sessionFilterApplied":return Object.keys(e).sort().join(",")==="request,state,type"&&s(e.request)&&e.request.length>0&&e.request.length<=128&&h(e.state)?{type:"sessionFilterApplied",request:e.request,state:e.state}:null;case"health":return Number.isSafeInteger(e.sequence)&&e.sequence>0?{type:"health",sequence:e.sequence}:null;case"ready":{let n=["readerPageId","readerDocumentId","readerChallenge"];return n.some(o=>e[o]!==void 0&&(typeof e[o]!="string"||!/^[a-f0-9]{32}$/.test(e[o])))||e.readerChallenge!==void 0&&(e.readerPageId===void 0||e.readerDocumentId===void 0)?null:{type:"ready",...Object.fromEntries(n.filter(o=>e[o]!==void 0).map(o=>[o,e[o]]))}}case"painted":return Number.isSafeInteger(e.generation)&&e.generation>=0&&(e.stage==="railReady"||e.stage==="firstCard"||e.stage==="completeRender")?{type:"painted",generation:e.generation,stage:e.stage,...e.usableRows===!0?{usableRows:!0}:{}}:null;case"rowsGap":return{type:"rowsGap"};case"initialize":return{type:"initialize"};case"developmentReload":return{type:"developmentReload"};case"refresh":return{type:"refresh"};case"perf":return kn(e.kind)&&A(e.ms)&&e.ms>=0?{type:"perf",kind:e.kind,ms:e.ms}:null;case"goBack":return{type:"goBack"};case"goForward":return{type:"goForward"};case"newSession":{if(e.owner!==void 0&&!s(e.owner))return null;let n=e.owner===void 0?{}:{owner:e.owner};if(e.request===void 0)return{type:"newSession",...n};let o=it(e.request);return o?{type:"newSession",request:o,...n}:null}case"pinSetup":{if(e.owner!==void 0&&!s(e.owner))return null;let n=e.owner===void 0?{}:{owner:e.owner},o=it(e.request);if(!o)return null;if(o.kind==="custom")return{type:"pinSetup",request:o,...n};let r=Je(h(e.request)?.values);return r?{type:"pinSetup",request:{...o,values:r},...n}:null}case"unpinSetup":return(e.owner===void 0||s(e.owner))&&s(e.id)&&e.id.trim().length>0&&e.id.length<=Xe?{type:"unpinSetup",id:e.id,...e.owner===void 0?{}:{owner:e.owner}}:null;case"refreshUsage":return{type:"refreshUsage",agent:s(e.agent)?e.agent:null,force:e.force===!0};case"requestDefaults":return(e.agent==="claude"||e.agent==="codex")&&s(e.model)&&e.model.length<=200?{type:"requestDefaults",agent:e.agent,model:e.model}:null;case"openControl":return s(e.control)&&s(e.session)?{type:"openControl",control:e.control,session:e.session}:null;case"pick":return s(e.agent)&&s(e.value)&&s(e.session)?{type:"pick",control:String(e.control),agent:e.agent,session:e.session,model:S(e.model,""),value:e.value}:null;case"draft":return s(e.text)&&s(e.session)?{type:"draft",text:e.text,keep:S(e.keep,e.text),session:e.session,...Number.isSafeInteger(e.revision)?{revision:e.revision}:{}}:null;case"contextDetail":return C(e.session)&&e.session&&y(e.request)&&y(e.generation)?{type:"contextDetail",session:e.session,request:e.request,generation:e.generation}:null;case"pathCompletion":return s(e.session)&&A(e.request)&&s(e.token)&&A(e.caret)?{type:"pathCompletion",session:e.session,request:e.request,token:e.token,caret:e.caret}:null;case"answerAsk":{if(!s(e.session)||!s(e.id))return null;let n=Dn(e.answer);return n?{type:"answerAsk",session:e.session,id:e.id,answer:n}:null}case"dropUris":return s(e.session)?{type:"dropUris",session:e.session,...Nn(e)}:null;case"beginFileStaging":return s(e.session)?{type:"beginFileStaging",session:e.session,token:S(e.token,"")}:null;case"attachFiles":return s(e.session)?{type:"attachFiles",session:e.session,token:S(e.token,""),clipboard:e.clipboard===!0,files:e.files}:null;case"fileReadError":return s(e.session)?{type:"fileReadError",session:e.session,token:S(e.token,""),name:S(e.name,"")}:null;case"fileRejected":return s(e.session)?{type:"fileRejected",session:e.session,code:S(e.code,"read"),name:S(e.name,""),size:st(e.size,0),rejected:st(e.rejected,0)}:null;case"removeFile":return s(e.session)&&s(e.value)?{type:"removeFile",session:e.session,value:e.value}:null;case"importPromptRecovery":return{type:"importPromptRecovery",submittedPrompts:e.submittedPrompts,...s(e.request)?{request:e.request}:{}};case"sendPrompt":return s(e.text)&&s(e.session)?{type:"sendPrompt",text:e.text,session:e.session,...e.attempt&&typeof e.attempt=="object"?{attempt:e.attempt}:{},revision:typeof e.revision=="number"&&Number.isSafeInteger(e.revision)&&e.revision>=0?e.revision:0}:null;case"compact":return s(e.session)?{type:"compact",session:e.session}:null;case"dismissLive":return s(e.session)?{type:"dismissLive",session:e.session,kind:S(e.kind,"")}:null;case"restoreLive":return s(e.session)?{type:"restoreLive",session:e.session,kind:S(e.kind,"")}:null;case"stopTurn":return s(e.session)?{type:"stopTurn",session:e.session}:null;case"dequeue":return s(e.value)&&s(e.session)?{type:"dequeue",value:e.value,session:e.session}:null;case"editQueued":return s(e.value)&&s(e.session)&&Number.isSafeInteger(e.revision)&&e.revision>=0?{type:"editQueued",value:e.value,session:e.session,revision:e.revision}:null;case"acceptQueuedEdit":return s(e.value)&&s(e.session)&&Number.isSafeInteger(e.revision)&&e.revision>=0&&Number.isSafeInteger(e.currentRevision)&&e.currentRevision>=0&&typeof e.accepted=="boolean"?{type:"acceptQueuedEdit",value:e.value,session:e.session,revision:e.revision,currentRevision:e.currentRevision,accepted:e.accepted}:null;case"copy":return s(e.text)?{type:"copy",text:e.text}:null;case"note":return{type:"note",note:e.note};case"armSelectedText":return s(e.session)&&e.session.length>0&&s(e.key)&&e.key.length>0?{type:"armSelectedText",session:e.session,key:e.key}:null;case"selectedTextHandoff":return s(e.session)&&e.session.length>0&&s(e.key)&&e.key.length>0&&s(e.text)&&e.text.trim().length>0&&typeof e.copyLabels=="boolean"?{type:"selectedTextHandoff",session:e.session,key:e.key,text:e.text,copyLabels:e.copyLabels}:null;case"armLinkMenu":{let n=Be(e.destination);return s(e.token)&&e.token.length>0&&e.token.length<=128&&n?{type:"armLinkMenu",token:e.token,destination:n}:null}case"armSessionDetails":return s(e.session)&&e.session.length>0?{type:"armSessionDetails",session:e.session}:null;case"armComposer":return{type:"armComposer"};case"showReaderParent":return s(e.session)&&e.session.length>0?{type:"showReaderParent",session:e.session}:null;case"showSession":return s(e.session)&&(e.responseLink===void 0||e.responseLink===!0)?{type:"showSession",session:e.session,...e.parent===!0?{parent:!0}:{},...e.responseLink===!0?{responseLink:!0}:{}}:null;case"labelEditor":return s(e.session)?{type:"labelEditor",session:e.session,...e.refresh===!0?{refresh:!0}:{}}:null;case"setLabels":return s(e.session)&&Array.isArray(e.names)?{type:"setLabels",session:e.session,names:e.names.filter(s)}:null;case"setViews":return de(e.views)?{type:"setViews",views:e.views}:null;case"renameSession":return s(e.session)&&e.session.length>0&&Number.isSafeInteger(e.request)&&s(e.title)?{type:"renameSession",session:e.session,request:e.request,title:e.title}:null;case"setRailFilters":return pe(e.railFilters)?{type:"setRailFilters",railFilters:e.railFilters}:null;case"sessionMembership":return s(e.session)?e.action==="pin"?e.openPinned!==void 0&&typeof e.openPinned!="boolean"?null:{type:"sessionMembership",action:e.action,session:e.session,...e.openPinned===!0?{openPinned:!0}:{}}:e.action==="archive"||e.action==="unarchive"||e.action==="unpin"?{type:"sessionMembership",action:e.action,session:e.session}:null:null;case"setLayout":return e.key==="cardLayout"&&ae(e.value)?{type:"setLayout",key:"cardLayout",value:e.value}:e.key==="promptPosition"&&le(e.value)?{type:"setLayout",key:"promptPosition",value:e.value}:null;case"exportSession":return s(e.session)&&e.session.length>0?{type:"exportSession",session:e.session}:null;case"saveState":return{type:"saveState",state:e.state};case"panelUsageMetrics":{if(Object.keys(e).sort().join(",")!=="counts,queries,type")return null;let n=Wn(e.counts),o=$n(e.queries);return n&&o?{type:"panelUsageMetrics",counts:n,queries:o}:null}case"search":return{type:"search",text:S(e.text,""),...e.retained===!0?{retained:!0}:{}};case"loadOlder":return s(e.session)?{type:"loadOlder",session:e.session,token:S(e.token,"")}:null;case"openDirectory":return s(e.path)?{type:"openDirectory",path:e.path}:null;case"openLink":if(e.destination!==void 0){let n=h(e.destination);return n&&n.kind==="fileCitation"&&s(n.path)&&e.href===void 0?{type:"openLink",destination:{kind:"fileCitation",path:n.path},beside:e.beside===!0}:null}return s(e.href)?{type:"openLink",href:e.href,beside:e.beside===!0}:null;case"openVisualization":return s(e.path)?{type:"openVisualization",path:e.path}:null;case"openImage":return s(e.path)?{type:"openImage",path:e.path,beside:e.beside===!0}:null;case"openTurnDiff":return s(e.key)?{type:"openTurnDiff",key:e.key,beside:e.beside===!0}:null;case"openCommit":return s(e.key)&&s(e.sha)?{type:"openCommit",key:e.key,sha:e.sha,dir:s(e.dir)?e.dir:null,beside:e.beside===!0}:null;case"openFile":return s(e.key)&&s(e.path)?{type:"openFile",key:e.key,path:e.path,beside:e.beside===!0,...s(e.sourceSessionId)?{sourceSessionId:e.sourceSessionId}:{}}:null;case"openSkill":return s(e.key)&&s(e.path)?{type:"openSkill",key:e.key,path:e.path,beside:e.beside===!0}:null;default:return null}}var Hn={readerRead:"noop",sessionFilterApplied:"noop",health:"noop",contextDetail:"handled",ready:"handled",rowsGap:"noop",painted:"noop",initialize:"noop",developmentReload:"noop",refresh:"noop",perf:"noop",goBack:"handled",goForward:"handled",newSession:"noop",pinSetup:"noop",unpinSetup:"noop",refreshUsage:"noop",openControl:"noop",requestDefaults:"noop",pick:"noop",draft:"noop",pathCompletion:"handled",answerAsk:"noop",beginFileStaging:"noop",attachFiles:"noop",dropUris:"noop",fileReadError:"noop",fileRejected:"noop",removeFile:"noop",sendPrompt:"noop",importPromptRecovery:"handled",compact:"noop",dismissLive:"noop",restoreLive:"noop",stopTurn:"noop",dequeue:"noop",editQueued:"noop",acceptQueuedEdit:"noop",copy:"handled",note:"handled",armSelectedText:"noop",selectedTextHandoff:"noop",armLinkMenu:"noop",armSessionDetails:"noop",armComposer:"noop",showReaderParent:"handled",showSession:"handled",labelEditor:"handled",setLabels:"handled",setViews:"handled",renameSession:"noop",setRailFilters:"handled",sessionMembership:"handled",setLayout:"handled",exportSession:"handled",saveState:"handled",panelUsageMetrics:"noop",search:"noop",loadOlder:"noop",openLink:"noop",openDirectory:"noop",openVisualization:"noop",openImage:"noop",openTurnDiff:"noop",openCommit:"noop",openFile:"noop",openSkill:"noop"};function Un(t,e,n){let o=e.agent==="codex"?"codex":"claude",r=e.contextTokens,a=e.contextWindow??2e5,i=e.model??"",u=Math.floor(r*.12),l=Math.floor(r*.35),c=Math.floor(r*.38),d=[{key:"instructions",name:o==="codex"?"Instructions":"System prompt",tokens:u,relationship:"used"},{key:"messages",name:"Messages",tokens:l,relationship:"used"},{key:"tools",name:o==="codex"?"Tool results":"System tools",tokens:c,relationship:"used"},{key:"other",name:o==="codex"?"Unattributed context":"Memory files",tokens:r-u-l-c,relationship:"used"}],g=Math.floor(l*.3),p=Math.floor(l*.25),f=Math.floor(l*.2),m=Math.floor(l*.15),R=Math.floor(l*.07),E={toolCallTokens:f,toolResultTokens:g,attachmentTokens:0,assistantMessageTokens:p,userMessageTokens:m,redirectedContextTokens:R,unattributedTokens:l-f-g-p-m-R},v=o==="codex"?{kind:"codex-retained-context",basis:"request",session:t.session,model:i,used:r,capacity:a,categories:d}:{model:i,totalTokens:r,rawMaxTokens:a,categories:[...d.map(k=>({name:k.name,tokens:k.tokens,kind:"used"})),{name:"Free space",tokens:Math.max(0,a-r-Math.floor(a*.1)),kind:"free"},{name:"Compaction buffer",tokens:Math.floor(a*.1),kind:"buffer"}],messageBreakdown:E},w=qe(v,{...t,provider:o,model:i,source:"demo"},n);if(!I(w)||w.status!=="available")throw new Error("Invalid demo context detail");return{type:"contextDetail",detail:w}}var dt={policy:Hn,parsePanelToHost:ct,parseHostToPanel:at,contextReply:Un};window.__ARC_DEMO_SAMPLES__.host=dt;window.__ARC_DEMO_SAMPLES__.labelRules={labelCounts:Y,labelEditorReply:be,labelsOf:z,railLabelFields:ye,setSessionLabels:he};window.__ARC_DEMO_SAMPLES__.readRules={newBySession:we};window.__ARC_DEMO_SAMPLES__.railRules={panelAgentRun:Fe};window.__ARC_DEMO_SAMPLES__.commentRules={applyComment:ve,normalizeComments:N};window.__ARC_DEMO_SAMPLES__.placeRules={emptyTrail:Se,visitPlace:ke,stepBack:Te,stepForward:Ce,trailPlace:J};window.__ARC_DEMO_SAMPLES__.isSendChord=Me;window.__ARC_DEMO_SAMPLES__.navigationShortcut=Ee;window.__ARC_DEMO_SAMPLES__.parseSessionLink=$e;window.__ARC_DEMO_SAMPLES__.installMenu=He;})();
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
  const railRules = sample.railRules;
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
      const held = labelRules.labelsOf(labels, row.id);
      const { labelClause, ...labelFields } = labelRules.railLabelFields(held, sample.labelWords.labelled);
      // The variants omit labels, so the label half of the filing rule applies here.
      const classified = original.railVariants['normal:read'][row.id].runByAgent;
      const runByAgent = railRules.panelAgentRun(classified, archived, pinned, held.length > 0);
      return {
        ...row,
        ...variant,
        ...labelFields,
        runByAgent,
        agentRun: runByAgent === true && !archived,
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
    const { queryContext, ...original } = sample.payloads[selected];
    deliver({ type: 'queryContext', queryContext });
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
