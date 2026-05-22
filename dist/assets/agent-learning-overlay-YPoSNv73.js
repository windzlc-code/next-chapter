import{readQualityPatterns as j,readComplianceRisks as b,readUserPreferenceStore as R}from"./agent-learning-store-B0sTsqDX.js";const $=/写|生成|创作|剧本|集|场景|撰写|续写|重写|细纲|目录/,y=new Set(["episodes","outlines","细纲","分集正文"]);function O(t,e){if(!e)return!1;if($.test(t))return!0;const n=e.derivedStage??"";return y.has(n)}function C(t,e,n){return t.filter(s=>s.targetMarket===n&&s.genres.some(i=>e.includes(i))).slice(-5)}function M(t,e,n){return t.filter(s=>s.riskLevel==="high"&&s.targetMarket===n&&s.genres.some(i=>e.includes(i))).slice(-3)}function v(t){if(!t.length)return"";const e={},n=new Set;for(const o of t){for(const r of o.weakDimensions)e[r]=(e[r]??0)+1;for(const r of o.issuePatterns)n.add(r)}const s=Object.entries(e).sort((o,r)=>r[1]-o[1]).slice(0,3).map(([o])=>o),i=["### 质量改进重点"];s.length&&i.push(`- 历史偏弱维度：${s.join("、")}`);const c=[...n].slice(0,3);for(const o of c)i.push(`- ${o}`);return i.join(`
`)}function E(t){if(!t.length)return"";const e=["### 合规风险提示（同类题材历史高风险）"];for(const n of t)e.push(`- ${n.issueTitle}`),n.recommendation&&e.push(`  建议：${n.recommendation}`);return e.join(`
`)}function T(t,e){if(!t.length&&!e.length)return"";const n=["### 用户偏好倾向"];return t.length&&n.push(`- 倾向认可：${t.slice(0,5).join("、")}`),e.length&&n.push(`- 倾向回避：${e.slice(0,5).join("、")}`),n.join(`
`)}function L(t){var p;const{currentProjectSnapshot:e,prompt:n}=t;if(!O(n,e))return null;const s=(p=e==null?void 0:e.artifacts)==null?void 0:p.find(u=>u.kind==="dramaSetup"||u.kind==="setup"),i=s==null?void 0:s.payload,c=(i==null?void 0:i.genres)??[],o=(i==null?void 0:i.targetMarket)??"",r=j(),m=b(),f=R(),S=c.length&&o?C(r,c,o):[],k=c.length&&o?M(m,c,o):[],a=v(S),g=E(k),d=T(f.positiveKeywords,f.negativeKeywords),h=[a,g,d].filter(Boolean);if(!h.length)return null;let l=h.join(`

`);return l.length>500&&(l=[g,a,d].filter(Boolean).join(`

`).slice(0,500)),`## 创作经验参考（基于历史项目学习）

${l}`}export{L as buildLearningMemoryOverlay,O as isLearningOverlayApplicable};
