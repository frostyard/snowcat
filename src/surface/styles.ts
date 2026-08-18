/**
 * The operator surface stylesheet, inlined into every page so no request
 * leaves the host: Frostyard tokens plus the Pilothouse admin-shell classes,
 * copied verbatim from `.agents/skills/frostyard-design/`, and the small
 * `fl-*` set the inbox artboard adds. The remote font import is dropped on
 * purpose; Inter falls back to the system sans stack.
 */
export const surfaceStylesheet = String.raw`
/* Copied from the frostyard-design skill: tokens/colors.css, tokens/typography.css (without the remote font import), tokens/spacing.css, and ui_kits/pilothouse/pilothouse.css. Edit the fl-* block only; re-copy the rest when the skill is synchronized. */
:root{
/* Base inks — darker blue backgrounds */
--ink:#06111d;--deep:#081b2d;--panel:#0d263b;--panel-bright:#0d2a41;
/* Cool/cold blue accents */
--ice:#aee9ff;--sky:#47b8ef;--blue:#168bd0;--mist:#b6d0df;--mist-bright:#c7dce8;
/* Text */
--text-body:#edf8ff;--text-muted:#b6d0df;--text-dim:#a6c1d0;--text-eyebrow:#82b6d0;--text-footer:#7799ab;--text-mono-accent:#8ddbf8;
/* Lines + borders */
--line:rgba(162,222,255,.18);--line-strong:#2c6380;--line-tag:#a6dffa38;
/* Semantic surfaces */
--surface-page:var(--ink);--surface-panel:var(--panel);--surface-code:#061826;
--gradient-page:radial-gradient(circle at 82% 2%,#10416455,transparent 27rem),linear-gradient(180deg,#071a2a 0%,#06111d 38%,#06111d 100%);/* @kind color */
--gradient-card:linear-gradient(160deg,#0f3048,#091c2d 62%);/* @kind color */
--gradient-card-alt:linear-gradient(160deg,#17445e,#0a1f31 64%);/* @kind color */
--gradient-card-deep:linear-gradient(160deg,#12364c,#081827 64%);/* @kind color */
--gradient-panel:linear-gradient(135deg,#0d2d45,#071827);/* @kind color */
--gradient-signal:linear-gradient(135deg,#0f3b58,#0b2034);/* @kind color */
--gradient-primary:linear-gradient(135deg,#5ac9f7,#1584ca);/* @kind color */
--gradient-ice-line:linear-gradient(90deg,#7edafa,transparent);/* @kind color */
--on-primary:#02131f;
/* Interactive */
--link:#8eddf9;--link-hover:var(--ice);--tag-text:#b9e9fb;
/* State (intentional additions for admin surfaces — cold-shifted) */
--state-ok:#7edafa;--state-ok-dim:#0e3247;--state-warn:#e0b15c;--state-warn-dim:#33291433;--state-danger:#e07a72;--state-danger-dim:#3a181e;
}
:root{
--font-sans:"Inter",ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
--font-serif-accent:Georgia,serif; /* italic <em> inside display headings only */
--font-mono:ui-monospace,SFMono-Regular,Menlo,monospace;
/* Display (hero h1) */
--text-display-size:clamp(3.4rem,6.4vw,6.4rem);--text-display-lh:.94;--text-display-ls:-.072em;--text-display-weight:700;
/* Section heading (h2) */
--text-h2-size:clamp(2.5rem,4vw,4.25rem);--text-h2-lh:1;--text-h2-ls:-.06em;
/* Sub-section heading (panel h2) */
--text-h2-compact-size:clamp(2.3rem,3.8vw,3.8rem);
/* Eyebrow kicker */
--text-eyebrow-size:.7rem;--text-eyebrow-ls:.17em;--text-eyebrow-weight:700;
/* Body */
--text-lede-size:1.08rem;--text-body-size:.93rem;--text-small-size:.87rem;--text-caption-size:.82rem;
/* Mono details */
--text-mono-size:.72rem;--text-tag-size:.68rem;
/* Brand wordmark */
--brand-weight:720;--brand-ls:-.04em;--brand-size:1.25rem;
}
:root{
/* Layout */
--container-max:1240px;--container-pad:32px;--container-pad-mobile:20px;--nav-height:92px;--nav-height-mobile:72px;
/* Section rhythm */
--section-pad:8rem;--section-pad-mobile:5rem;--panel-pad:3.5rem;--card-pad:1.35rem;--tool-pad:2.2rem 2.4rem;
/* Radii — nearly square; pills only for nav source link */
--radius-tag:2px;--radius-node:3px;--radius-button:4px;--radius-pill:100px;
/* Rules */
--eyebrow-dash-w:24px;
}
.ph-shell{display:grid;grid-template-columns:204px minmax(0,1fr);min-height:100vh}
.ph-sidebar{background:var(--deep);border-right:1px solid var(--line);color:#b7d0df;display:flex;flex-direction:column;min-height:100vh;padding:16px 12px 14px;position:sticky;top:0;height:100vh}
.ph-brand{align-items:center;color:var(--text-body);display:flex;gap:9px;padding:0 8px 16px;text-decoration:none;white-space:nowrap;font-weight:720;letter-spacing:-.04em}
.ph-brand .flake{color:var(--ice);font-size:1.45rem}
.ph-brand strong{display:block;font-size:14px;letter-spacing:-.02em}
.ph-brand small{color:var(--text-eyebrow);display:block;font-size:10px;margin-top:2px;font-weight:400;letter-spacing:.08em;text-transform:uppercase;font-family:var(--font-mono)}
.ph-sys-picker{display:grid;gap:4px;margin:0 6px 4px;padding-bottom:12px;border-bottom:1px solid var(--line)}
.ph-sys-picker label{color:#7cbddc;font:700 9.5px var(--font-mono);letter-spacing:.14em;text-transform:uppercase}
.ph-sys-picker select{background:var(--surface-code);border:1px solid var(--line);color:var(--text-body);font:12px var(--font-sans);padding:6px 8px;border-radius:var(--radius-tag);width:100%}
.ph-sys-picker select:focus{outline:none;border-color:var(--sky)}
.ph-nav{display:flex;flex:1;flex-direction:column;gap:2px}
.ph-nav-group{color:#7cbddc;font:700 9.5px var(--font-mono);letter-spacing:.14em;margin:16px 10px 5px;text-transform:uppercase}
.ph-nav-link{align-items:center;color:#9db8c8;display:flex;font-size:12.5px;font-weight:570;gap:10px;min-height:31px;padding:0 10px;text-decoration:none;border-left:1px solid transparent;transition:.15s ease}
.ph-nav-link:hover{color:var(--ice)}
.ph-nav-link.active{color:var(--ice);border-left:1px solid var(--sky);background:linear-gradient(90deg,rgba(71,184,239,.08),transparent)}
.ph-nav-num{font:400 10px var(--font-mono);color:#4f7893;width:20px}
.ph-nav-link.active .ph-nav-num{color:var(--sky)}
.ph-side-foot{align-items:center;border-top:1px solid var(--line);display:flex;gap:9px;margin:14px 6px 0;padding-top:13px}
.ph-avatar{align-items:center;background:var(--gradient-primary);color:var(--on-primary);display:flex;flex:0 0 auto;font-size:11px;font-weight:800;height:30px;justify-content:center;width:30px;border-radius:var(--radius-tag)}
.ph-side-user{flex:1;min-width:0}
.ph-side-user strong{display:block;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ph-side-user small{color:var(--text-footer);display:block;font-size:10px;margin-top:2px}
.ph-main{min-width:0;padding:0 26px 32px}
.ph-topbar{align-items:center;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;min-height:68px;padding:12px 0 14px}
.ph-eyebrow{color:var(--text-eyebrow);font-size:10px;font-weight:720;letter-spacing:.14em;margin-bottom:4px;text-transform:uppercase}
.ph-eyebrow i{display:inline-block;width:20px;height:1px;background:var(--sky);vertical-align:middle;margin-right:.5rem}
.ph-topbar h1{font-size:clamp(20px,2.2vw,24px);font-weight:700;letter-spacing:-.05em;margin:0}
.ph-topbar-actions{align-items:center;display:flex;gap:10px}.ph-topbar-actions>*{flex-shrink:0}
.ph-live{align-items:center;white-space:nowrap;border:1px solid var(--line);border-radius:var(--radius-pill);color:#8ddbf8;display:flex;font:700 9.5px var(--font-mono);gap:6px;letter-spacing:.1em;padding:5px 9px;text-transform:uppercase}
.ph-live>*{flex-shrink:0;min-width:max-content}.ph-hero-kicker>*{flex-shrink:0;min-width:max-content}.ph-live span:empty{animation:ph-pulse 2s infinite;background:var(--sky);border-radius:50%;height:6px;width:6px}
.ph-grid{display:grid;gap:10px;grid-template-columns:repeat(6,minmax(0,1fr))}
.ph-span-full{grid-column:span 6}.ph-span-half{grid-column:span 3}.ph-span-third{grid-column:span 2}.ph-grid>div:not(.ph-card){display:grid}
.ph-card{background:var(--gradient-card);border:1px solid var(--line);padding:13px 15px;min-width:0}
.ph-card-heading{align-items:center;display:flex;gap:10px;margin-bottom:10px}
.ph-card-heading.split{justify-content:space-between}
.ph-card-heading h2{font-size:13px;font-weight:700;margin:0;letter-spacing:-.01em}
.ph-card-heading p,.ph-subtle{color:#8fb0c2;font-size:11px;margin:3px 0 0}
.ph-card-link{color:#93e0fb;font-size:11px;font-weight:700;text-decoration:none;white-space:nowrap}
.ph-card-link:hover{color:var(--ice)}
.ph-hero{background:var(--gradient-signal);border:1px solid var(--line-strong);color:var(--text-body);min-height:118px;overflow:hidden;padding:16px 20px;position:relative}
.ph-hero-kicker{align-items:center;white-space:nowrap;color:#93dff7;display:flex;font:700 10px var(--font-mono);letter-spacing:.12em;gap:7px;margin-bottom:9px;text-transform:uppercase}
.ph-hero-kicker span:empty{background:var(--sky);border-radius:50%;height:7px;width:7px}
.ph-hero h2{font-size:20px;font-weight:700;letter-spacing:-.045em;margin:0 0 5px}
.ph-hero h2 em{font-family:var(--font-serif-accent);font-weight:400;color:var(--ice)}
.ph-hero p{color:#a9c7d5;font-size:11.5px;line-height:1.6;margin:0;max-width:60%}
.ph-hero-art{position:absolute;inset:0;pointer-events:none}
.ph-hero-art img{position:absolute;right:0;top:0;height:100%;width:55%;object-fit:cover;object-position:60% 55%;opacity:.5;mask-image:linear-gradient(90deg,transparent,#000 45%)}
.ph-facts{border-collapse:collapse;bottom:16px;font-size:11px;position:absolute;right:20px;z-index:1}
.ph-facts th{color:#7cbddc;font:500 9px var(--font-mono);letter-spacing:.08em;padding:3px 18px 3px 0;text-align:left;text-transform:uppercase}
.ph-facts td{font-size:12px;font-weight:650;padding:3px 0}
.ph-metric strong{font-size:23px;font-weight:700;letter-spacing:-.05em}
.ph-metric-row{align-items:baseline;display:flex;gap:5px;margin-top:2px}
.ph-metric-row span{color:#8fb0c2;font-size:11px}
.ph-meter{background:#0a2236;height:4px;margin:10px 0 7px;overflow:hidden}
.ph-meter>span{background:var(--gradient-primary);display:block;height:100%;min-width:2px}
.ph-meter.warn>span{background:var(--state-warn)}
.ph-meter.danger>span{background:var(--state-danger)}
.ph-metric-foot{color:#7a9cb0;display:flex;font-size:10px;justify-content:space-between}
.ph-mini{display:grid;gap:0}
.ph-mini-row{align-items:center;border-bottom:1px solid var(--line);display:grid;gap:8px;grid-template-columns:minmax(0,1fr) auto;min-height:30px;padding:6px 0}
.ph-mini-row:last-child{border-bottom:0}
.ph-mini-row strong{display:block;font-size:11.5px}
.ph-mini-row small{color:#7a9cb0;display:block;font-size:9.5px;margin-top:3px;font-family:var(--font-mono)}
.ph-badge{border:1px solid var(--line-tag);color:var(--tag-text);display:inline-flex;font:700 9px var(--font-mono);letter-spacing:.08em;padding:4px 7px;text-transform:uppercase;border-radius:var(--radius-tag);white-space:nowrap}
.ph-badge.ok{border-color:#47b8ef4d;color:var(--state-ok)}
.ph-badge.warn{border-color:#e0b15c55;color:var(--state-warn)}
.ph-badge.danger{border-color:#e07a7255;color:var(--state-danger)}
.ph-button{align-items:center;background:var(--gradient-primary);border:0;color:var(--on-primary);cursor:pointer;display:inline-flex;font-size:10.5px;font-weight:700;gap:6px;min-height:27px;padding:0 10px;text-decoration:none;border-radius:var(--radius-button);white-space:nowrap;font-family:var(--font-sans)}
.ph-button.secondary{background:transparent;border:1px solid var(--line);color:#c9e6f5}
.ph-button.secondary:hover{color:var(--ice);border-color:#8fdffb66}
.ph-button.danger{background:var(--state-danger-dim);color:var(--state-danger);border:1px solid #e07a7233}
.ph-button:disabled{cursor:not-allowed;opacity:.5}
.ph-table-card{overflow:hidden;padding:0}
.ph-table-toolbar{align-items:center;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;padding:10px 14px}
.ph-table-toolbar h2{font-size:13px;margin:0}
.ph-table-toolbar span{color:#7a9cb0;font:10px var(--font-mono)}
.ph-table{border-collapse:collapse;width:100%}
.ph-table th{color:#7cbddc;font:750 9px var(--font-mono);letter-spacing:.12em;padding:8px 14px;text-align:left;text-transform:uppercase}
.ph-table td{border-top:1px solid var(--line);font-size:11.5px;padding:8px 14px;vertical-align:middle}
.ph-name strong{display:block;font-size:11.5px}
.ph-name small{color:#7a9cb0;display:block;font-size:9.5px;margin-top:3px}
.ph-version{color:#8ddbf8;font-family:var(--font-mono);font-size:10px}
.ph-actions{display:flex;gap:6px;justify-content:flex-end}
.ph-stats{display:grid;gap:10px;grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:10px}
.ph-stat{background:var(--gradient-card);border:1px solid var(--line);display:grid;gap:3px;padding:11px 14px}
.ph-stat>span{color:#7cbddc;font:750 9px var(--font-mono);letter-spacing:.12em;text-transform:uppercase}
.ph-stat strong{font-size:19px;font-weight:700;letter-spacing:-.04em}
.ph-stat strong.ph-version{font-size:15px;letter-spacing:0}
.ph-stat small{color:#7a9cb0;font-size:9.5px}
.ph-login-body{min-height:100vh;padding:28px;display:grid;place-items:center}
.ph-login{background:var(--gradient-card);border:1px solid var(--line);display:grid;grid-template-columns:minmax(360px,1fr) minmax(320px,.9fr);max-width:950px;min-height:600px;overflow:hidden;width:100%}
.ph-login-panel{display:flex;flex-direction:column;padding:42px 54px 34px}
.ph-login-copy{margin-top:auto}
.ph-login-copy h1{font-size:34px;font-weight:700;letter-spacing:-.055em;margin:0 0 12px;line-height:1}
.ph-login-copy h1 em{font-family:var(--font-serif-accent);font-weight:400;color:var(--ice)}
.ph-login-copy p{color:var(--text-muted);font-size:12px;line-height:1.7;margin:0;max-width:390px}
.ph-login-form{display:grid;gap:15px;margin-top:30px}
.ph-login-form label{color:#93bfd6;display:grid;font:750 10px var(--font-mono);gap:7px;letter-spacing:.1em;text-transform:uppercase}
.ph-login-form input{background:var(--surface-code);border:1px solid var(--line);color:var(--text-body);font:13px var(--font-sans);min-height:43px;outline:none;padding:0 12px;text-transform:none;border-radius:var(--radius-tag)}
.ph-login-form input:focus{border-color:var(--sky);box-shadow:0 0 0 3px rgba(71,184,239,.12)}
.ph-login-foot{color:var(--text-footer);font-size:9.5px;margin:auto 0 0;padding-top:28px}
.ph-login-art{position:relative;overflow:hidden;border-left:1px solid var(--line)}
.ph-login-art img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:62% 40%}
.ph-login-art>div{bottom:45px;left:40px;position:absolute;z-index:1}
.ph-login-art span{color:#93dff7;display:block;font:700 10px var(--font-mono);letter-spacing:.14em;margin-bottom:12px;text-transform:uppercase}
.ph-login-art strong{font-size:30px;font-weight:700;letter-spacing:-.05em;line-height:1.1;display:block;max-width:280px}
@keyframes ph-pulse{0%,100%{box-shadow:0 0 0 0 rgba(71,184,239,.4)}50%{box-shadow:0 0 0 5px rgba(71,184,239,0)}}
@media(max-width:1050px){.ph-span-third{grid-column:span 3}.ph-facts{display:none}.ph-hero p{max-width:100%}}
@media(max-width:760px){.ph-shell{display:block}.ph-sidebar{height:auto;min-height:0;padding:15px;position:static}.ph-nav{flex-direction:row;overflow-x:auto}.ph-nav-group,.ph-side-foot{display:none}.ph-main{padding:0 16px 35px}.ph-grid{grid-template-columns:1fr}.ph-span-full,.ph-span-half,.ph-span-third{grid-column:auto}.ph-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.ph-login{display:block}.ph-login-art{display:none}}

/* Base (from ui_kits/pilothouse/index.html) */
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background-color:var(--ink);background-image:var(--gradient-page);color:var(--text-body);font-family:var(--font-sans);line-height:1.5}
a{color:var(--link)}a:hover{color:var(--link-hover)}
button{font-family:inherit}
code{font-family:var(--font-mono);color:var(--text-mono-accent)}
/* Fluent surface additions (fl-*), values lifted from the Inbox artboard */
.fl-host{display:grid;gap:4px;margin:0 6px 4px;padding-bottom:12px;border-bottom:1px solid var(--line)}
.fl-host span{color:#7cbddc;font:700 9.5px var(--font-mono);letter-spacing:.14em;text-transform:uppercase}
.fl-host code{background:var(--surface-code);border:1px solid var(--line);color:var(--text-body);font-size:12px;font-family:var(--font-sans);padding:6px 8px;border-radius:var(--radius-tag);display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ph-nav-link.disabled{color:#4f7893;cursor:not-allowed}
.fl-repo{align-items:center;color:#9db8c8;display:flex;font-size:12px;gap:8px;min-height:28px;padding:0 10px 0 22px;text-decoration:none}
.fl-repo span{width:6px;height:6px;background:#4f7893;display:inline-block;flex:0 0 auto}
.fl-repo span.ok{background:var(--state-ok)}
.fl-repo em{font-style:normal;color:#4f7893;font:10px var(--font-mono);margin-left:auto}
.fl-side-foot{border-top:1px solid var(--line);color:var(--text-footer);font:10px var(--font-mono);padding:12px 8px 0;line-height:1.6}
.fl-columns{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:10px;align-items:start}
.fl-stack{display:grid;gap:10px}
.fl-group{background:var(--gradient-card);border:1px solid var(--line);overflow:hidden}
.fl-group-head{align-items:center;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;padding:10px 14px}
.fl-group-head h2{font-size:13px;margin:0;font-weight:700;letter-spacing:-.02em}
.fl-group-head span{color:#7a9cb0;font:10px var(--font-mono)}
.fl-table{border-collapse:collapse;width:100%}
.fl-table th{color:#7cbddc;font:750 9px var(--font-mono);letter-spacing:.12em;padding:8px 14px;text-align:left;text-transform:uppercase}
.fl-table td{border-top:1px solid var(--line);padding:9px 14px;font-size:11.5px;vertical-align:top}
.fl-table td.right,.fl-table th.right{text-align:right}
.fl-name strong{display:block;font-size:11.5px}
.fl-name strong span{color:var(--text-muted);font-weight:400}
.fl-name small,.fl-sub{color:#7a9cb0;display:block;font-size:9.5px;margin-top:3px}
.fl-finding{margin-top:8px;padding:8px 10px;background:var(--surface-code);border:1px solid var(--line);color:var(--mist-bright);font-size:10.5px;line-height:1.5}
.fl-finding span{color:#7cbddc;font:750 9px var(--font-mono);letter-spacing:.12em;text-transform:uppercase;display:block;margin-bottom:4px}
.fl-reason{max-width:520px;color:var(--mist-bright);font-size:10.5px;line-height:1.5}
.fl-badges{display:flex;flex-wrap:wrap;gap:4px}
.fl-badges .ph-badge{color:#9db8c8;border-color:var(--line)}
.fl-actions{display:flex;gap:6px;justify-content:flex-end}
.fl-exit{display:grid;gap:6px;justify-content:end}
.fl-note{width:300px;min-height:44px;background:var(--surface-code);border:1px solid var(--line);color:var(--text-body);font:11px var(--font-sans);padding:6px 8px;resize:vertical}
.fl-note:disabled{opacity:.5;cursor:not-allowed}
.ph-button.reject{background:transparent;border:1px solid var(--line);color:var(--state-danger)}
.fl-empty{color:#7a9cb0;font-size:11px;padding:12px 14px}
.fl-events{display:flex;flex-direction:column}
.fl-event{border-top:1px solid var(--line);display:grid;grid-template-columns:52px minmax(0,1fr);gap:8px;padding:8px 14px}
.fl-event time{color:var(--text-footer);font:10px var(--font-mono);padding-top:2px}
.fl-event-head{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.fl-event-head b{color:var(--text-mono-accent);font:700 10px var(--font-mono)}
.fl-event-head span{font-size:11px;color:var(--text-body);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px}
.fl-event small{color:#7a9cb0;font-size:9.5px;margin-top:2px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fl-footer{border-top:1px solid var(--line);color:var(--text-footer);font:10px var(--font-mono);margin-top:24px;padding-top:12px;display:flex;flex-wrap:wrap;gap:6px 18px}
.fl-error{background:var(--state-danger-dim);border:1px solid #e07a7233;color:var(--state-danger);font-size:12px;padding:8px 12px;margin-bottom:10px}
.fl-logout{display:inline}
.ph-login-art{background:var(--gradient-signal)}
@media(max-width:1050px){.fl-columns{grid-template-columns:1fr}}
/* Repository board (Repository board artboard) */
.fl-repo.active{color:var(--ice)}
.fl-facts{color:#7a9cb0;font:10px var(--font-mono)}
.fl-board{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;align-items:start}
.fl-column{min-height:520px}
.fl-rows{display:flex;flex-direction:column}
.fl-row{display:block;border-top:1px solid var(--line);padding:10px 14px;color:var(--text-body);text-decoration:none}
.fl-row:hover{background:rgba(71,184,239,.05);color:var(--text-body)}
.fl-row-head{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}
.fl-row-head strong{font-size:11.5px;font-weight:600;line-height:1.35}
.fl-row-head strong span{color:var(--text-muted);font-weight:400}
.fl-row>small{color:#7a9cb0;display:block;font-size:9.5px;margin-top:3px}
.fl-tags{display:flex;gap:4px;flex-shrink:0}
.fl-tags .ph-badge{color:#9db8c8;border-color:var(--line)}
.fl-tags .ph-badge.ok{color:var(--state-ok);border-color:#47b8ef4d}
.fl-tags .ph-badge.warn{color:var(--state-warn);border-color:#e0b15c55}
.fl-tags .ph-badge.danger{color:var(--state-danger);border-color:#e07a7255}
.fl-lease{margin-top:8px}
.fl-lease-head{display:flex;justify-content:space-between;color:#7a9cb0;font:10px var(--font-mono)}
.fl-lease-bar{height:2px;background:var(--surface-code);margin-top:4px}
.fl-lease-bar>div{height:2px;background:var(--gradient-ice-line)}
/* Item page (Item artboard) */
.fl-item{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:10px;align-items:start}
.fl-def{padding:12px 14px;font-size:11.5px;color:var(--mist-bright);line-height:1.55}
.fl-objective{margin:0 0 8px;color:var(--text-body);font-size:12.5px;font-weight:600}
.fl-def-row{display:grid;grid-template-columns:120px minmax(0,1fr);gap:8px;padding:6px 0;border-top:1px solid var(--line)}
.fl-def-row>span:first-child{color:#7cbddc;font:750 9px var(--font-mono);letter-spacing:.12em;text-transform:uppercase;padding-top:3px}
.fl-def-label{color:#7cbddc;font:750 9px var(--font-mono);letter-spacing:.12em;text-transform:uppercase;margin:12px 0 6px}
.fl-pre{margin:0;white-space:pre-wrap;word-break:break-word;font:11px var(--font-mono);color:var(--mist-bright);background:var(--surface-code);border:1px solid var(--line);padding:8px 10px;max-height:320px;overflow:auto}
.fl-criteria{margin:0;padding-left:18px}
.fl-criteria li{margin:2px 0}
.fl-criteria-tight{margin-top:4px;font-size:10.5px;color:#a9c7d5}
.fl-table-flush th:first-child,.fl-table-flush td:first-child{padding-left:0}
.fl-table-flush th,.fl-table-flush td{padding-left:8px;padding-right:8px}
.fl-stack-sm{display:grid;gap:10px}
.fl-note-row{display:grid;grid-template-columns:110px minmax(0,1fr);gap:8px}
.fl-note-row>span:first-child{color:var(--text-footer);font:10px var(--font-mono)}
.fl-note-row>span:last-child{font-size:11px;white-space:pre-wrap;word-break:break-word}
.fl-timeline-row{border-top:1px solid var(--line);display:grid;grid-template-columns:60px 130px minmax(0,1fr);gap:10px;padding:8px 14px;align-items:baseline}
.fl-timeline-row time{color:var(--text-footer);font:10px var(--font-mono)}
.fl-timeline-row b{color:var(--text-mono-accent);font:700 10px var(--font-mono);overflow:hidden;text-overflow:ellipsis}
.fl-timeline-row>span{font-size:11px;color:var(--mist-bright);overflow-wrap:anywhere}
.fl-muted{color:#7a9cb0;font-style:normal}
.fl-event-head a{font-size:11px;color:var(--text-body);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px}
.fl-event-head a:hover{color:var(--ice)}
.fl-name a{color:inherit;text-decoration:none}.fl-name a:hover{color:var(--ice)}
/* Mutation forms */
.fl-decide{display:grid;gap:6px;justify-items:end}
.fl-decide .fl-actions{align-items:center}
.fl-input{width:100%;max-width:300px;background:var(--surface-code);border:1px solid var(--line);color:var(--text-body);font:11px var(--font-sans);padding:5px 8px;border-radius:var(--radius-tag)}
.fl-input:focus,.fl-note:focus{outline:none;border-color:var(--sky)}
.fl-input-num{width:64px;text-align:right}
.fl-inline{display:inline}
.fl-banner{background:var(--state-ok-dim);border:1px solid #47b8ef4d;color:var(--state-ok);font-size:12px;padding:8px 12px;margin-bottom:10px}
#actions .fl-decide{justify-items:start}
#actions .fl-input,#actions .fl-note{max-width:none;width:100%}
#actions .fl-exit{display:grid;gap:6px;justify-content:stretch}
#actions .fl-note{width:100%}

@media(max-width:1050px){.fl-board{grid-template-columns:1fr}.fl-item{grid-template-columns:1fr}.fl-column{min-height:0}}


`;
