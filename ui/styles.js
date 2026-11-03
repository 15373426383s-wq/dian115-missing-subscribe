// Liquid Glass 材质：透光层 + 折射 + 高光边。样式全部限定在 .ms 内，不影响宿主。
export const styles = `
.ms{--ink:var(--app-text,#16181d);--ink2:var(--app-text-secondary,#5d6470);--accent:var(--app-accent,#3b82f6);
 --tint:rgba(255,255,255,.46);--tint-strong:rgba(255,255,255,.66);--edge:rgba(255,255,255,.78);--edge-low:rgba(255,255,255,.2);
 --shade:rgba(24,32,56,.14);--ok:#17915f;--warn:#b86e00;--bad:#d03a4b;
 --r-xl:30px;--r-l:22px;--r-m:16px;--r-s:11px;
 position:relative;isolation:isolate;display:flex;flex-direction:column;min-height:100%;height:100%;box-sizing:border-box;padding:24px 28px 18px;color:var(--ink);
 font:15px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Noto Sans CJK SC",sans-serif;overflow:hidden}
.ms[data-mode=dark]{--tint:rgba(44,48,60,.42);--tint-strong:rgba(52,57,70,.68);--edge:rgba(255,255,255,.3);--edge-low:rgba(255,255,255,.08);
 --shade:rgba(0,0,0,.42);--ok:#4cd39b;--warn:#ffb74d;--bad:#ff7686}
.ms *,.ms *::before,.ms *::after{box-sizing:border-box}
.ms-ambient{position:absolute;inset:0;z-index:-1;overflow:hidden;background:var(--app-bg,#eef1f6)}
.ms-ambient i{position:absolute;border-radius:50%;filter:blur(64px);opacity:.62;animation:ms-drift 26s ease-in-out infinite alternate}
.ms-ambient i:nth-child(1){width:46vmax;height:46vmax;left:-12%;top:-20%;background:#6fb7ff}
.ms-ambient i:nth-child(2){width:38vmax;height:38vmax;right:-10%;top:4%;background:#a48bff;animation-delay:-9s}
.ms-ambient i:nth-child(3){width:34vmax;height:34vmax;left:26%;bottom:-26%;background:#5fe0c6;animation-delay:-17s}
.ms[data-mode=dark] .ms-ambient i{opacity:.3}
@keyframes ms-drift{to{transform:translate3d(6%,8%,0) scale(1.14)}}
.ms-glass{position:relative;background:linear-gradient(135deg,var(--tint-strong),var(--tint));border-radius:var(--r-l);
 -webkit-backdrop-filter:blur(22px) saturate(180%);backdrop-filter:blur(22px) saturate(180%);
 box-shadow:inset 0 1px 0 var(--edge),inset 1px 0 0 var(--edge-low),inset 0 -1px 0 var(--edge-low),0 14px 38px -14px var(--shade),0 2px 6px -2px var(--shade)}
.ms.ms-refract .ms-lens{-webkit-backdrop-filter:url(#ms-refraction) blur(9px) saturate(190%);backdrop-filter:url(#ms-refraction) blur(9px) saturate(190%)}
.ms-glass::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;opacity:var(--glow,0);transition:opacity .25s;
 background:radial-gradient(240px circle at var(--mx,50%) var(--my,0%),rgba(255,255,255,.34),transparent 70%)}
.ms-head{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:20px}
.ms-head h1{margin:0;font-size:30px;line-height:1.15;font-weight:700;letter-spacing:-.02em}
.ms-head p{margin:4px 0 0;color:var(--ink2);font-size:14px}
.ms-grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr))}
.ms-stat{padding:18px 20px;min-height:112px;border-radius:var(--r-l)}
.ms-stat b{display:block;font-size:34px;line-height:1.1;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.ms-stat span{color:var(--ink2);font-size:13px}
.ms-section{margin-top:18px;padding:20px}
.ms-section>h2,.ms-sheet h2{margin:0 0 12px;font-size:17px;font-weight:650}
.ms-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ms-spread{justify-content:space-between}
.ms-muted{color:var(--ink2);font-size:13px}
.ms-btn{appearance:none;border:0;cursor:pointer;font:inherit;font-weight:600;font-size:14px;color:var(--ink);min-height:40px;padding:0 18px;border-radius:999px;
 background:var(--tint);box-shadow:inset 0 1px 0 var(--edge),0 2px 8px -3px var(--shade);transition:transform .22s cubic-bezier(.3,1.6,.5,1),background .2s}
.ms-btn:hover{background:var(--tint-strong)}.ms-btn:active{transform:scale(.95)}
.ms-btn:focus-visible,.ms-chip:focus-visible,.ms-tab:focus-visible,.ms-switch:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.ms-btn[disabled]{opacity:.5;cursor:default}
.ms-btn.primary{color:#fff;background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 86%,#fff),var(--accent));box-shadow:inset 0 1px 0 rgba(255,255,255,.5),0 8px 20px -8px var(--accent)}
.ms-btn.small{min-height:32px;padding:0 13px;font-size:13px}
.ms-btn.danger{color:var(--bad)}
.ms-content{flex:1;min-height:0;overflow-y:auto}
.ms-dock-wrap{position:sticky;bottom:18px;z-index:20;display:flex;justify-content:center;margin-top:28px;pointer-events:none}
.ms-dock{pointer-events:auto;display:flex;gap:2px;padding:5px;border-radius:999px;max-width:100%;overflow-x:auto;scrollbar-width:none}
.ms-pill{position:absolute;top:5px;bottom:5px;left:0;border-radius:999px;background:var(--tint-strong);box-shadow:inset 0 1px 0 var(--edge),0 3px 10px -3px var(--shade);transition:transform .42s cubic-bezier(.3,1.35,.45,1),width .42s cubic-bezier(.3,1.35,.45,1)}
.ms-tab{position:relative;z-index:1;appearance:none;border:0;background:none;color:var(--ink2);font:inherit;font-size:14px;font-weight:600;min-height:40px;padding:0 17px;border-radius:999px;cursor:pointer;white-space:nowrap}
.ms-tab[aria-selected=true]{color:var(--ink)}
.ms-tab sup{margin-left:3px;font-size:11px;color:var(--accent)}
.ms-list{display:grid;gap:10px}
.ms-item{display:flex;align-items:center;gap:13px;padding:11px 14px;border-radius:var(--r-m)}
.ms-item>div.grow{min-width:0;flex:1}
.ms-item strong{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ms-poster{flex:none;width:42px;height:60px;border-radius:9px;object-fit:cover;display:grid;place-items:center;font-weight:700;color:#fff;background:linear-gradient(145deg,#7cc4ff,#7a6bff);box-shadow:inset 0 0 0 1px var(--edge-low)}
.ms-tag{display:inline-flex;align-items:center;min-height:23px;padding:0 9px;border-radius:999px;font-size:12px;font-weight:600;background:var(--tint);color:var(--ink2);white-space:nowrap}
.ms-tag.ok{color:var(--ok)}.ms-tag.warn{color:var(--warn)}.ms-tag.bad{color:var(--bad)}.ms-tag.info{color:var(--accent)}
.ms-empty{padding:42px 18px;text-align:center;color:var(--ink2)}
.ms-switch{appearance:none;flex:none;position:relative;width:52px;height:30px;margin:0;border:0;border-radius:999px;cursor:pointer;background:var(--shade);box-shadow:inset 0 1px 3px var(--shade);transition:background .25s}
.ms-switch::after{content:"";position:absolute;top:3px;left:3px;width:32px;height:24px;border-radius:999px;background:#fff;box-shadow:0 2px 7px rgba(0,0,0,.28);transition:transform .34s cubic-bezier(.3,1.5,.5,1)}
.ms-switch:checked{background:var(--ok)}.ms-switch:checked::after{transform:translateX(14px)}
.ms-scrim{position:fixed;inset:0;z-index:40;display:flex;justify-content:flex-end;background:rgba(10,14,24,.2);animation:ms-fade .2s}
.ms-sheet{width:min(560px,100%);height:100%;overflow-y:auto;padding:24px;border-radius:var(--r-xl) 0 0 var(--r-xl);animation:ms-slide .34s cubic-bezier(.2,.9,.3,1);background:color-mix(in srgb,var(--app-surface,#fff) 90%,transparent);-webkit-backdrop-filter:blur(34px) saturate(170%);backdrop-filter:blur(34px) saturate(170%)}
@keyframes ms-fade{from{opacity:0}}@keyframes ms-slide{from{transform:translateX(40px);opacity:0}}
.ms-fields{display:grid;gap:12px;grid-template-columns:repeat(2,minmax(0,1fr));margin-bottom:18px}
.ms-field{display:grid;gap:5px;font-size:13px;color:var(--ink2)}.ms-field.wide{grid-column:1/-1}
.ms-field input,.ms-field select{width:100%;font:inherit;font-size:15px;color:var(--ink);min-height:42px;padding:0 13px;border:0;border-radius:var(--r-s);background:var(--tint);box-shadow:inset 0 1px 3px var(--shade)}
.ms-field input:focus,.ms-field select:focus{outline:2px solid var(--accent);outline-offset:-1px}
.ms-seg{display:flex;gap:3px;padding:3px;border-radius:999px;background:var(--shade)}
.ms-seg button{flex:1;appearance:none;border:0;background:none;color:var(--ink2);font:inherit;font-size:13px;font-weight:600;min-height:36px;padding:0 10px;border-radius:999px;cursor:pointer}
.ms-seg button[aria-pressed=true]{color:var(--ink);background:var(--tint-strong);box-shadow:inset 0 1px 0 var(--edge),0 2px 6px -2px var(--shade)}
.ms-chips{display:flex;flex-wrap:wrap;gap:6px}
.ms-chip{appearance:none;border:0;font:inherit;font-size:13px;min-height:32px;padding:0 12px;border-radius:999px;cursor:pointer;color:var(--ink2);background:var(--tint)}
.ms-chip[aria-pressed=true]{color:#fff;background:var(--accent)}
.ms-toast{position:fixed;left:50%;top:22px;transform:translateX(-50%);z-index:60;padding:10px 18px;border-radius:999px;font-weight:600;font-size:14px;max-width:calc(100% - 32px)}
.ms-sheet .ms-actions{background:color-mix(in srgb,var(--app-surface,#fff) 94%,transparent)}
.ms-actions{position:sticky;bottom:-24px;display:flex;justify-content:flex-end;gap:10px;margin:0 -24px -24px;padding:14px 24px;border-radius:0}
@media (max-width:640px){.ms{padding:16px}.ms-head h1{font-size:25px}.ms-fields{grid-template-columns:minmax(0,1fr)}.ms-sheet{height:auto;max-height:92%;margin-top:auto;border-radius:var(--r-xl) var(--r-xl) 0 0}.ms-scrim{align-items:flex-end}.ms-tab{padding:0 13px}.ms-item{flex-wrap:wrap}.ms-item>div.grow{flex-basis:calc(100% - 56px)}}
@media (prefers-reduced-motion:reduce){.ms *,.ms *::before,.ms *::after{animation:none!important;transition:none!important}}
@media (prefers-reduced-transparency:reduce){.ms-glass,.ms.ms-refract .ms-lens{-webkit-backdrop-filter:none;backdrop-filter:none;background:var(--app-surface,#fff)}}
`
