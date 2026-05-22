import{readQualityPatterns as k,readComplianceRisks as y,readUserPreferenceStore as S}from"./agent-learning-store-B0sTsqDX-B9YqpD6G-B9YqpD6G-B9YqpD6G-B9YqpD6G-B9YqpD6G.js";const $=/写|生成|创作|剧本|集|场景|撰写|续写|重写|细纲|目录/,w=new Set(["episodes","outlines","细纲","分集正文"]);function M(t,e){if(!e)return!1;if($.test(t))return!0;const n=e.derivedStage??"";return w.has(n)}function P(t,e,n){return t.filter(o=>o.targetMarket===n&&o.genres.some(s=>e.includes(s))).slice(-5)}function b(t,e,n){return t.filter(o=>o.riskLevel==="high"&&o.targetMarket===n&&o.genres.some(s=>e.includes(s))).slice(-3)}function L(t){if(!t.length)return"";const e={},n=new Set;for(const r of t){for(const i of r.weakDimensions)e[i]=(e[i]??0)+1;for(const i of r.issuePatterns)n.add(i)}const o=Object.entries(e).sort((r,i)=>i[1]-r[1]).slice(0,3).map(([r])=>r),s=["### 质量改进重点"];o.length&&s.push(`- 历史偏弱维度：${o.join("、")}`);const l=[...n].slice(0,3);for(const r of l)s.push(`- ${r}`);return s.join(`
`)}function O(t){if(!t.length)return"";const e=["### 合规风险提示（同类题材历史高风险）"];for(const n of t)e.push(`- ${n.issueTitle}`),n.recommendation&&e.push(`  建议：${n.recommendation}`);return e.join(`
`)}function B(t,e){if(!t.length&&!e.length)return"";const n=["### 用户偏好倾向"];return t.length&&n.push(`- 倾向认可：${t.slice(0,5).join("、")}`),e.length&&n.push(`- 倾向回避：${e.slice(0,5).join("、")}`),n.join(`
`)}function D(t){var e;const{currentProjectSnapshot:n,prompt:o}=t;if(!M(o,n))return null;const s=(e=n==null?void 0:n.artifacts)==null?void 0:e.find(h=>h.kind==="dramaSetup"||h.kind==="setup"),l=s==null?void 0:s.payload,r=(l==null?void 0:l.genres)??[],i=(l==null?void 0:l.targetMarket)??"",p=k(),m=y(),a=S(),v=r.length&&i?P(p,r,i):[],j=r.length&&i?b(m,r,i):[],c=L(v),f=O(j),d=B(a.positiveKeywords,a.negativeKeywords),g=[c,f,d].filter(Boolean);if(!g.length)return null;let u=g.join(`

`);return u.length>500&&(u=[f,c,d].filter(Boolean).join(`

`).slice(0,500)),`## 创作经验参考（基于历史项目学习）

${u}`}export{D as buildLearningMemoryOverlay,M as isLearningOverlayApplicable};
