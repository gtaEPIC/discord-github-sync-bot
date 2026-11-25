/**
 * The mapping settings editor in the admin console: a visual editor for every bridge setting
 * (src/bridge/config.ts) and a raw JSON editor, with switching between them. The server
 * validates whatever is saved; this editor only helps people get it right.
 */

const needsBridge =
  '<p class="bridge-note subtle">Used in Bridge mode only. Saving in Linked accounts mode leaves these out.</p>';

export const settingsDialog = `<dialog id="settings-dialog" class="settings-dialog" aria-labelledby="settings-title"><form id="settings-form" novalidate>
<div class="dialog-heading"><div><span class="section-label">BRIDGE SETTINGS</span><h2 id="settings-title">Mapping settings</h2></div><button type="button" class="text-button" id="close-settings" aria-label="Close dialog">×</button></div>
<div class="editor-tabs" role="tablist" aria-label="Editor">
<button type="button" role="tab" id="settings-tab-visual" data-editor="visual" aria-selected="true" aria-controls="settings-visual">Visual</button>
<button type="button" role="tab" id="settings-tab-raw" data-editor="raw" aria-selected="false" aria-controls="settings-raw" tabindex="-1">JSON</button>
</div>
<div id="settings-error" class="form-error" role="alert" hidden></div>
<div id="settings-visual" role="tabpanel" aria-labelledby="settings-tab-visual">
<section class="settings-card">
<header><h3>Write mode</h3><p class="subtle">How posts, replies and tag changes from Discord reach GitHub.</p></header>
<div class="tiles">
<label class="tile"><input type="radio" name="s-mode" value="user"><span><b>Linked accounts</b><small>Each Discord author links a GitHub account and writes as themselves. GitHub always wins for titles and tags.</small></span></label>
<label class="tile"><input type="radio" name="s-mode" value="bridge"><span><b>Bridge</b><small>The GitHub App bot writes and names the Discord author. Renames and tag changes in Discord reach GitHub.</small></span></label>
</div>
</section>
<fieldset class="settings-card" data-needs-bridge>
<header><h3>Who can write</h3><p class="subtle">Limits on Discord members writing to GitHub through the bridge.</p></header>${needsBridge}
<div class="setting-field"><span class="field-name">Allowed roles</span><small class="field-help">Members with any of these roles can write. None listed means everyone who can post in the forum.</small><div class="chips" id="s-roles" data-kind="roles" data-list="dl-roles" data-placeholder="Role name or ID"></div></div>
<div class="setting-pair">
<label>New issues per hour<input type="number" id="s-issues" min="0" max="10000" step="1" placeholder="5"><small class="field-help">Per member. 0 means no limit.</small></label>
<label>Comments per hour<input type="number" id="s-comments" min="0" max="10000" step="1" placeholder="60"><small class="field-help">Per member. 0 means no limit.</small></label>
</div>
</fieldset>
<fieldset class="settings-card" data-needs-bridge>
<header><h3>Webhooks and bots</h3><p class="subtle">Sync posts and replies made by webhooks (such as bug report forms) and other bots. The bridge's own messages are never synced.</p></header>${needsBridge}
<label>Webhooks<select id="s-webhooks"><option value="off">Don't sync webhook posts</option><option value="all">Sync every webhook</option><option value="list">Sync only the webhooks listed below</option></select></label>
<div class="setting-field" id="s-webhook-field"><span class="field-name">Webhooks to sync</span><small class="field-help">Webhook IDs: the number after /webhooks/ in the webhook URL.</small><div class="chips" id="s-webhook-list" data-kind="webhooks" data-list="dl-webhooks" data-placeholder="Webhook name or ID"></div></div>
<div class="setting-field"><span class="field-name">Bots to sync</span><small class="field-help">Bot user IDs. With Discord's developer mode on, right-click the bot and choose Copy User ID.</small><div class="chips" id="s-bots" data-kind="bots" data-list="dl-bots" data-placeholder="Bot name or ID"></div></div>
</fieldset>
<section class="settings-card">
<header><h3>Labels</h3><p class="subtle">A forum tag and a repository label with the same name (ignoring case) already match. Add a row only where the names differ.</p></header>
<div class="rows" id="s-labels"></div>
</section>
<section class="settings-card">
<header><h3>Close tags</h3><p class="subtle">Forum tags that mean closed. Applying one closes the issue with its reason; removing them all reopens it. The first one is shown when GitHub's reason has no tag of its own.</p></header>
<div class="rows" id="s-close"></div>
</section>
<section class="settings-card">
<header class="toggle-header"><div><h3>Project status</h3><p class="subtle">Sync a Projects v2 single-select field with forum tags. Needs the Projects token.</p></div><label class="switch"><input type="checkbox" id="s-status-on"><span>Enabled</span></label></header>
<div id="s-status-body" class="settings-body">
<div class="setting-pair"><label>Project owner<input id="s-owner" placeholder="GitHub login" autocomplete="off"></label><label>Project number<input id="s-number" type="number" min="1" step="1" placeholder="From the project URL"></label></div>
<div class="setting-pair"><label>Field<input id="s-field" placeholder="Status" autocomplete="off"></label><label>Check the board every<span class="with-unit"><input id="s-poll" type="number" min="60" max="3600" step="1" placeholder="120"><span>seconds</span></span></label></div>
<label>Status for new issues<input id="s-default" list="dl-options" placeholder="Leave empty to not add issues to the board" autocomplete="off"><small class="field-help">Open issues that are not on the board yet are added with this status.</small></label>
<div class="setting-field"><span class="field-name">Status tags</span><small class="field-help">Leave out the column your close tags stand for, such as Done.</small><div class="rows" id="s-status-tags"></div></div>
</div>
</section>
<section class="settings-card">
<header class="toggle-header"><div><h3>Activity messages</h3><p class="subtle">Post what happens on GitHub in the thread: references, closes, renames, labels and Status moves.</p></div><label class="switch"><input type="checkbox" id="s-timeline-on"><span>Enabled</span></label></header>
<div id="s-timeline-body" class="settings-body"><label>Keep checking closed issues for<span class="with-unit"><input id="s-days" type="number" min="0" max="365" step="1" placeholder="14"><span>days</span></span></label></div>
</section>
</div>
<div id="settings-raw" role="tabpanel" aria-labelledby="settings-tab-raw" hidden>
<label>Settings (JSON) <span class="subtle">An empty object means upstream behaviour. Switch back to Visual to check it.</span><textarea id="settings-json" rows="20" spellcheck="false"></textarea></label>
</div>
<datalist id="dl-tags"></datalist><datalist id="dl-labels"></datalist><datalist id="dl-roles"></datalist><datalist id="dl-webhooks"></datalist><datalist id="dl-bots"></datalist><datalist id="dl-options"></datalist>
<div class="dialog-actions"><button type="button" id="cancel-settings">Cancel</button><button type="submit" class="primary">Save settings →</button></div>
</form></dialog>`;

export const settingsCss = `.settings-dialog{width:min(800px,calc(100vw - 30px))}
.editor-tabs{display:flex;border-bottom:1px solid var(--line);margin:-10px 0 20px}
.editor-tabs button{border:0;border-bottom:2px solid transparent;border-radius:0;background:none;padding:8px 16px;color:var(--muted);font-size:12px;margin-bottom:-1px}
.editor-tabs button:hover{background:none;color:#20201e}
.editor-tabs button[aria-selected=true]{color:#20201e;border-bottom-color:var(--accent);font-weight:600}
.settings-card{border:1px solid var(--line);background:var(--paper);border-radius:4px;padding:16px 18px;margin:0 0 14px;min-width:0;display:grid;gap:14px}
.settings-card h3{font-size:14px;font-weight:600;margin:0 0 4px}
.settings-card[disabled]>:not(header):not(.bridge-note){opacity:.45}
.bridge-note{display:none;border-left:2px solid #c26a3d;padding:2px 10px}
.settings-card[disabled] .bridge-note{display:block}
.settings-body{display:grid;gap:14px}
.settings-body[hidden]{display:none}
.toggle-header{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}
.switch{display:inline-flex;align-items:center;gap:8px;white-space:nowrap;cursor:pointer}
.switch input{width:auto;margin:0;accent-color:var(--accent)}
.tiles{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.tile{display:flex;gap:10px;align-items:flex-start;border:1px solid #c9cac0;border-radius:4px;padding:12px;cursor:pointer;background:#fff}
.tile:has(input:checked){border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent);background:#fbf3ee}
.tile input{width:auto;margin:2px 0 0;accent-color:var(--accent)}
.tile b{display:block;font-size:12px;margin-bottom:4px;color:#20201e}
.tile small{display:block;color:var(--muted);font-weight:400;line-height:1.5}
.setting-pair{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.field-name{display:block;font-size:11px;font-weight:500;color:#525449}
.field-help{display:block;color:var(--muted);font-weight:400;font-size:10.5px;margin-top:5px;line-height:1.5}
.field-help.warn{color:#af582e}
.field-help:empty{display:none}
.field-error{display:block;color:#963d23;font-size:10.5px;margin-top:2px;flex-basis:100%}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;align-items:center}
.chip{display:inline-flex;align-items:center;gap:6px;border:1px solid #c9cac0;border-radius:14px;padding:3px 4px 3px 11px;background:#fff;font-size:11px}
.chip small{color:var(--muted);font:9.5px ui-monospace,SFMono-Regular,Consolas,monospace}
.chip .text-button{padding:0 5px;font-size:14px;line-height:1}
.chip-input{display:flex;gap:6px;flex:1 1 260px}
.chip-input input{margin:0}
.with-unit{display:flex;align-items:center;gap:8px}
.with-unit input{flex:1}
.with-unit span{font-weight:400;color:var(--muted);margin-top:7px}
.rows{display:grid;gap:6px}
.rows .row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) 28px;gap:8px;align-items:start}
.rows .row input,.rows .row select{margin:0}
.rows .row.head span{font:9px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:1px;color:var(--muted);text-transform:uppercase}
.rows .row>.text-button{font-size:18px;padding:7px 0}
.rows .empty-rows{font-size:11px;color:var(--muted);margin:0}
.add-row{justify-self:start;border-style:dashed;background:transparent}
#settings-json{min-height:380px}
@media(max-width:640px){.tiles,.setting-pair{grid-template-columns:1fr}.toggle-header{flex-direction:column}}
`;

/** Runs inside the console script, which defines $, api, post, busy, refresh, notice, option. */
export const settingsJs = String.raw`
let settingsMapping,settingsEditor='visual',settingsHints=[];
const SETTING_KEYS=['writeMode','allowRoles','allowWebhooks','allowBots','rateLimit','labels','closeTags','status','timeline'];
const NO_CHOICES={tags:[],roles:[],labels:[],webhooks:[],bots:[],statusOptions:[]};
let settingsChoices=NO_CHOICES;
const asObject=v=>v&&typeof v==='object'&&!Array.isArray(v)?v:{};
const asStrings=v=>Array.isArray(v)?v.map(String):[];
function settingsProblem(text){$('settings-error').textContent=text;$('settings-error').hidden=false;$('settings-dialog').scrollTop=0;}
function forumTag(name){return settingsChoices.tags.find(t=>t.name.toLowerCase()===String(name).trim().toLowerCase());}
function tagCheck(moderated){return value=>{if(!String(value).trim()||!settingsChoices.tags.length)return '';const tag=forumTag(value);if(!tag)return 'This forum has no tag with this name.';return moderated&&!tag.moderated?'Make this tag moderated in Discord, so only staff can apply it.':'';};}
const SETTING_ROWS={
 's-labels':{add:'Add label',empty:'No renamed labels.',cols:[{key:'tag',label:'Forum tag',list:'dl-tags',max:20,check:tagCheck(false)},{key:'label',label:'GitHub label',list:'dl-labels',max:50,check:v=>!String(v).trim()||!settingsChoices.labels.length||settingsChoices.labels.some(l=>l.toLowerCase()===String(v).trim().toLowerCase())?'':'The repository has no label with this name.'}]},
 's-close':{add:'Add close tag',empty:'No close tags: closing happens on GitHub or with /issue close.',cols:[{key:'tag',label:'Forum tag',list:'dl-tags',max:20,check:tagCheck(true)},{key:'reason',label:'Closes as',options:[['completed','Completed'],['not_planned','Not planned'],['duplicate','Duplicate']]}]},
 's-status-tags':{add:'Add status tag',empty:'No status tags yet.',cols:[{key:'tag',label:'Forum tag',list:'dl-tags',max:20,check:tagCheck(true)},{key:'option',label:'Status option',list:'dl-options',max:100,check:v=>!String(v).trim()||!settingsChoices.statusOptions.length||settingsChoices.statusOptions.includes(String(v).trim())?'':'The field has no option with this name.'}]}
};
function renderRows(id){
 const box=$(id),spec=SETTING_ROWS[id];box.replaceChildren();
 if(box._rows.length){const head=document.createElement('div');head.className='row head';for(const col of spec.cols){const s=document.createElement('span');s.textContent=col.label;head.append(s);}box.append(head);}
 else{const p=document.createElement('p');p.className='empty-rows';p.textContent=spec.empty;box.append(p);}
 box._rows.forEach((row,i)=>{
  const line=document.createElement('div');line.className='row';
  for(const col of spec.cols){
   const cell=document.createElement('div');let input;
   if(col.options){input=document.createElement('select');for(const [value,label] of col.options)option(input,label,value);}
   else{input=document.createElement('input');input.setAttribute('list',col.list);input.maxLength=col.max;input.autocomplete='off';}
   input.value=row[col.key]??'';input.setAttribute('aria-label',col.label+', row '+(i+1));cell.append(input);
   let update=()=>{};
   if(col.check){const note=document.createElement('small');note.className='field-help warn';cell.append(note);update=()=>{note.textContent=col.check(input.value);};settingsHints.push(update);update();}
   input.oninput=input.onchange=()=>{row[col.key]=input.value;update();};
   line.append(cell);
  }
  const remove=document.createElement('button');remove.type='button';remove.className='text-button';remove.textContent='×';remove.setAttribute('aria-label','Remove row '+(i+1));
  remove.onclick=()=>{box._rows.splice(i,1);renderRows(id);};line.append(remove);box.append(line);
 });
 const add=document.createElement('button');add.type='button';add.className='add-row';add.textContent='+ '+spec.add;
 add.onclick=()=>{box._rows.push(Object.fromEntries(spec.cols.map(c=>[c.key,c.options?c.options[0][0]:''])));renderRows(id);const lines=box.querySelectorAll('.row:not(.head)');lines[lines.length-1].querySelector('input,select').focus();};
 box.append(add);
}
function renderChips(id){
 const box=$(id),kind=box.dataset.kind,named=settingsChoices[kind]||[];box.replaceChildren();
 for(const value of box._values){
  const chip=document.createElement('span');chip.className='chip';const name=named.find(x=>x.id===value)?.name;
  const b=document.createElement('b');b.textContent=name||value;chip.append(b);
  if(name){const s=document.createElement('small');s.textContent=value;chip.append(s);}
  const x=document.createElement('button');x.type='button';x.className='text-button';x.textContent='×';x.setAttribute('aria-label','Remove '+(name||value));
  x.onclick=()=>{box._values=box._values.filter(v=>v!==value);renderChips(id);box.querySelector('input').focus();};chip.append(x);box.append(chip);
 }
 const row=document.createElement('div');row.className='chip-input';
 const input=document.createElement('input');input.setAttribute('list',box.dataset.list);input.placeholder=box.dataset.placeholder;input.autocomplete='off';input.setAttribute('aria-label',box.dataset.placeholder);
 const add=document.createElement('button');add.type='button';add.textContent='Add';
 const error=document.createElement('small');error.className='field-error';error.hidden=true;
 const commit=()=>{const text=input.value.trim();if(!text)return;const match=named.find(x=>x.name.toLowerCase()===text.toLowerCase()||x.id===text);const value=match?match.id:text;
  if(!/^\d{5,25}$/.test(value)){error.textContent='Choose a name from the list or enter a numeric ID.';error.hidden=false;return;}
  if(!box._values.includes(value))box._values.push(value);renderChips(id);box.querySelector('input').focus();};
 input.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();commit();}};input.oninput=()=>error.hidden=true;add.onclick=commit;
 row.append(input,add);box.append(row,error);
}
function settingsVisibility(){
 const bridge=document.querySelector('input[name="s-mode"]:checked')?.value==='bridge';
 for(const card of document.querySelectorAll('[data-needs-bridge]'))card.disabled=!bridge;
 $('s-webhook-field').hidden=$('s-webhooks').value!=='list';
 $('s-status-body').hidden=!$('s-status-on').checked;$('s-timeline-body').hidden=!$('s-timeline-on').checked;
}
function renderSettings(){settingsHints=[];for(const id of Object.keys(SETTING_ROWS))renderRows(id);for(const id of ['s-roles','s-webhook-list','s-bots'])renderChips(id);settingsVisibility();}
function loadVisual(config){
 const c=asObject(config),rate=asObject(c.rateLimit),status=asObject(c.status),timeline=asObject(c.timeline);
 document.querySelector('input[name="s-mode"][value="'+(c.writeMode==='bridge'?'bridge':'user')+'"]').checked=true;
 $('s-roles')._values=asStrings(c.allowRoles);
 $('s-issues').value=rate.issuesPerHour??5;$('s-comments').value=rate.commentsPerHour??60;
 $('s-webhooks').value=c.allowWebhooks===true?'all':Array.isArray(c.allowWebhooks)?'list':'off';
 $('s-webhook-list')._values=asStrings(c.allowWebhooks);$('s-bots')._values=asStrings(c.allowBots);
 $('s-labels')._rows=Object.entries(asObject(c.labels)).map(([tag,label])=>({tag,label:String(label)}));
 $('s-close')._rows=(Array.isArray(c.closeTags)?c.closeTags:[]).map(t=>({tag:String(asObject(t).tag??''),reason:asObject(t).reason||'completed'}));
 $('s-status-on').checked=Boolean(c.status);$('s-owner').value=status.owner??'';$('s-number').value=status.number??'';$('s-field').value=status.field??'';
 $('s-poll').value=status.pollSeconds??'';$('s-default').value=status.defaultOption??'';
 $('s-status-tags')._rows=Object.entries(asObject(status.tags)).map(([tag,option])=>({tag,option:String(option)}));
 $('s-timeline-on').checked=Boolean(c.timeline);$('s-days').value=timeline.maxAgeDaysClosed??'';
 renderSettings();
}
/** A whole number from an input; empty gives the default, anything else is left for the server to reject. */
function settingNumber(input,fallback){const text=input.value.trim();if(text==='')return fallback;const n=Number(text);return Number.isFinite(n)?n:text;}
const filledRows=(rows,keys)=>rows.filter(r=>keys.some(k=>String(r[k]??'').trim()));
/** The visual editor as settings, leaving out defaults so the JSON stays short. */
function visualConfig(){
 const c={};
 if(document.querySelector('input[name="s-mode"]:checked')?.value==='bridge'){
  c.writeMode='bridge';
  if($('s-roles')._values.length)c.allowRoles=[...$('s-roles')._values];
  const issues=settingNumber($('s-issues'),5),comments=settingNumber($('s-comments'),60);
  if(issues!==5||comments!==60)c.rateLimit={issuesPerHour:issues,commentsPerHour:comments};
  if($('s-webhooks').value==='all')c.allowWebhooks=true;else if($('s-webhooks').value==='list')c.allowWebhooks=[...$('s-webhook-list')._values];
  if($('s-bots')._values.length)c.allowBots=[...$('s-bots')._values];
 }
 const labels=filledRows($('s-labels')._rows,['tag','label']);
 if(labels.length)c.labels=Object.fromEntries(labels.map(r=>[r.tag.trim(),r.label.trim()]));
 const close=filledRows($('s-close')._rows,['tag']);
 if(close.length)c.closeTags=close.map(r=>({tag:r.tag.trim(),reason:r.reason}));
 if($('s-status-on').checked){
  const status={owner:$('s-owner').value.trim(),number:settingNumber($('s-number'),undefined)};
  const field=$('s-field').value.trim();if(field&&field!=='Status')status.field=field;
  status.tags=Object.fromEntries(filledRows($('s-status-tags')._rows,['tag','option']).map(r=>[r.tag.trim(),r.option.trim()]));
  const initial=$('s-default').value.trim();if(initial)status.defaultOption=initial;
  const poll=settingNumber($('s-poll'),120);if(poll!==120)status.pollSeconds=poll;
  c.status=status;
 }
 if($('s-timeline-on').checked){const days=settingNumber($('s-days'),14);c.timeline=days===14?{}:{maxAgeDaysClosed:days};}
 return c;
}
function settingsTab(name){
 if(name!==settingsEditor){
  $('settings-error').hidden=true;
  if(name==='raw')$('settings-json').value=JSON.stringify(visualConfig(),null,2);
  else{
   let parsed;
   try{parsed=JSON.parse($('settings-json').value.trim()||'{}');}catch{settingsProblem('Fix the JSON before switching to the visual editor.');return;}
   if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)){settingsProblem('Settings must be a JSON object.');return;}
   const unknown=Object.keys(parsed).filter(k=>!SETTING_KEYS.includes(k));
   if(unknown.length){settingsProblem('Unknown setting '+unknown.map(k=>'"'+k+'"').join(', ')+'. Remove it before switching.');return;}
   loadVisual(parsed);
  }
 }
 settingsEditor=name;
 for(const tab of document.querySelectorAll('[data-editor]')){const on=tab.dataset.editor===name;tab.setAttribute('aria-selected',String(on));tab.tabIndex=on?0:-1;}
 $('settings-visual').hidden=name!=='visual';$('settings-raw').hidden=name!=='raw';
}
function fillSettingLists(){
 const fill=(id,items)=>{const list=$(id);list.replaceChildren();for(const item of items){const o=document.createElement('option');o.value=typeof item==='string'?item:item.name;if(typeof item!=='string'&&item.id)o.label=item.id;list.append(o);}};
 fill('dl-tags',settingsChoices.tags);fill('dl-labels',settingsChoices.labels);fill('dl-roles',settingsChoices.roles);
 fill('dl-webhooks',settingsChoices.webhooks);fill('dl-bots',settingsChoices.bots);fill('dl-options',settingsChoices.statusOptions);
}
function openSettings(mapping){
 settingsMapping=mapping;settingsChoices=NO_CHOICES;fillSettingLists();
 $('settings-title').textContent=mapping.owner+'/'+mapping.repo;$('settings-error').hidden=true;
 settingsEditor='visual';loadVisual(mapping.bridge||{});settingsTab('visual');
 $('settings-dialog').showModal();
 api('/api/mappings/'+mapping.id+'/settings-choices').then(choices=>{
  if(settingsMapping!==mapping||!$('settings-dialog').open)return;
  settingsChoices={...NO_CHOICES,...choices};fillSettingLists();
  for(const update of settingsHints)update();
  for(const id of ['s-roles','s-webhook-list','s-bots'])if(!$(id).contains(document.activeElement))renderChips(id);
 }).catch(()=>{});
}
// The user dashboard shares this script but has no settings dialog.
if($('settings-dialog')){
for(const tab of document.querySelectorAll('[data-editor]')){
 tab.onclick=()=>settingsTab(tab.dataset.editor);
 tab.onkeydown=event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();const next=settingsEditor==='visual'?'raw':'visual';settingsTab(next);document.querySelector('[data-editor="'+settingsEditor+'"]').focus();}};
}
for(const input of document.querySelectorAll('input[name="s-mode"]'))input.onchange=settingsVisibility;
for(const id of ['s-webhooks','s-status-on','s-timeline-on'])$(id).onchange=settingsVisibility;
for(const id of ['close-settings','cancel-settings'])$(id).onclick=()=>$('settings-dialog').close();
$('settings-form').onsubmit=event=>{event.preventDefault();busy(event.target,async()=>{try{
 let config;
 if(settingsEditor==='raw'){try{config=JSON.parse($('settings-json').value.trim()||'{}');}catch{throw new Error('Settings must be valid JSON.');}}
 else config=visualConfig();
 await post('/api/mappings/'+settingsMapping.id+'/config',{config});
 $('settings-dialog').close();await refresh();notice('Settings saved. The mapping is reconnecting.');
}catch(error){settingsProblem(error.message);}});};
}
`;
