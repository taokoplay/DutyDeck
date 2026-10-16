/* 镜头设置弹窗：独立保存表单 DOM，Agent 回流只刷新资产与版本区域。 */
'use strict';

/** 判断指定镜头是否存在未保存的实际输入；没有草稿时返回 false。 */
function shotDraftDirty(current=project(),selected=shot()){
  /** 时长输入以数字比较，避免原生 number 输入的字符串造成假修改。 */
  const draft=shotDrafts.get(`${current.id}/${selected.id}`);
  return !!draft&&Object.keys(shotEditValues(selected)).some(field=>field==='duration'?Number(draft[field])!==selected[field]:draft[field]!==selected[field]);
}

/** 返回可编辑字段；保存操作由弹窗固定底栏通过 form 属性关联。 */
function renderShotSettingsForm(selected){
  /** 读取独立镜头草稿，弹窗冻结项目、镜头与打开时的基线版本。 */
  const draft=shotDrafts.get(`${state.projectId}/${selected.id}`);
  const isImage=project().kind==='图片';
  return `<form id="shot-edit-form" class="shot-settings-form" data-project-id="${esc(state.projectId)}" data-shot-id="${esc(selected.id)}" data-version="${selected.version}">
    <div class="shot-settings-section-heading"><h3>${isImage?'当前图片':'当前镜头'}</h3><span>${String(episodeShots().indexOf(selected)+1).padStart(2,'0')} / ${String(episodeShots().length).padStart(2,'0')}</span></div>
    <label class="creative-field"><span>名称</span><input name="title" aria-label="名称" required maxlength="80" value="${esc(draft.title)}" autofocus></label>
    <div class="shot-settings-pair ${isImage?'is-image':''}">${isImage?'':`<label class="creative-field"><span>时长（秒）</span><input name="duration" aria-label="时长（秒）" type="number" min="0.1" max="600" step="0.1" required value="${esc(draft.duration)}"></label>`}<label class="creative-field"><span>${isImage?'构图':'运镜'}</span><input name="motion" aria-label="${isImage?'构图':'运镜'}" maxlength="1000" value="${esc(draft.motion)}"></label></div>
    <label class="creative-field"><span>画面描述</span><textarea id="edit-scene" name="scene" aria-label="画面描述" rows="3" required maxlength="2000">${esc(draft.scene)}</textarea></label>
    <label class="creative-field"><span>${isImage?'画面文案':'旁白 / 对白'}</span><textarea name="dialogue" aria-label="${isImage?'画面文案':'旁白 / 对白'}" rows="2" maxlength="1000">${esc(draft.dialogue)}</textarea></label>
  </form>`;
}

/** 将当前草稿状态同步到固定底栏；打开、输入与重置均不替换操作按钮。 */
function syncShotSettingsFeedback(){
  /** 只依据实际字段变化显示重置入口。 */
  const dirty=shotDraftDirty();
  document.getElementById('shot-settings-feedback').textContent=dirty?'有未保存的修改':'设置仅保留在本次演示中';
  document.querySelector('[data-action="reset-shot-settings"]').hidden=!dirty;
}

/** 根据 selected 返回引用资产 HTML；expanded 控制展开，默认窄屏收起。 */
function renderShotSettingsAssets(selected,expanded=window.matchMedia('(min-width:681px)').matches){
  /** 只展示显式关联资产，不用项目资产总数替代引用数量。 */
  const assets=project().assets.filter(asset=>(selected.assetIds||[]).includes(asset.id));
  return `<details class="shot-settings-section" ${expanded?'open':''}><summary class="shot-settings-section-heading"><h3>引用资产</h3><span>${assets.length} 项</span>${icon('chevron')}</summary><div class="shot-settings-assets">${assets.length?assets.map(asset=>`<div class="shot-settings-asset">${asset.image?`<img src="${esc(asset.image)}" alt="">`:`<span class="shot-settings-asset-placeholder">${icon('layers')}</span>`}<span><strong>${esc(asset.name)}</strong><small>v${asset.version} · ${esc(assetType(asset))}</small></span><span class="shot-settings-asset-lock" aria-label="${asset.locked?'已锁定':'未锁定'}" title="${asset.locked?'已锁定':'未锁定'}">${icon(asset.locked?'lock':'unlock')}</span></div>`).join(''):'<p class="shot-settings-empty">尚未引用资产</p>'}</div></details>`;
}

/** 根据 selected 返回版本状态 HTML；expanded 控制展开，采用版本独立于设定修订。 */
function renderShotSettingsVersions(selected,expanded=window.matchMedia('(min-width:681px)').matches){
  /** 候选必须同时匹配当前项目与镜头；初始已采用镜头沿用示例版本。 */
  const candidate=state.candidate?.projectId===state.projectId&&state.candidate.shotId===selected.id?state.candidate:null;
  const adopted=selected.adoptedVersion!==undefined?selected.adoptedVersion:selected.status==='adopted'?selected.version:null;
  const count=(selected.takes?.length||0)+(candidate?1:0);
  const status=state.task?.running&&state.task.shotId===selected.id&&state.task.projectId===state.projectId?'生成中':candidate?'待确认':selected.needsUpdate?'待重新生成':shotStatusLabel(selected);
  return `<details class="shot-settings-section" ${expanded?'open':''}><summary class="shot-settings-section-heading"><h3>生成与版本</h3><span>${candidate?'待确认':`${count} 个候选`}</span>${icon('chevron')}</summary><dl class="shot-settings-version-list"><div><dt>当前采用</dt><dd class="${adopted?'is-adopted':''}">${adopted?`v${adopted}`:'尚未采用'}</dd></div><div><dt>候选状态</dt><dd class="${status==='已采用'?'is-adopted':'is-pending'}">${status==='已采用'?icon('check'):''}${status}</dd></div></dl>${candidate?renderCandidate(candidate):''}</details>`;
}

/** 打开当前镜头的设置；仅首次创建草稿，关闭再打开仍保留输入。 */
function openShotSettings(){
  pauseStoryboard();
  /** 播放停止并同步目标后再冻结镜头身份。 */
  const selected=shot();
  const key=`${state.projectId}/${selected.id}`;
  const dialog=document.getElementById('shot-settings-dialog');
  if(!shotDrafts.has(key))shotDrafts.set(key,shotEditValues(selected));
  dialog.dataset.projectId=state.projectId;dialog.dataset.shotId=selected.id;
  dialog.querySelector('#shot-settings-title').textContent=project().kind==='图片'?'图片设置':'镜头设置';
  dialog.querySelector('.shot-settings-body').innerHTML=`${renderShotSettingsForm(selected)}<aside class="shot-settings-sidebar" aria-label="镜头资产与版本"><div class="shot-settings-assets-region">${renderShotSettingsAssets(selected)}</div><div class="shot-settings-versions-region">${renderShotSettingsVersions(selected)}</div></aside>`;
  document.getElementById('shot-settings-save').textContent=project().kind==='图片'?'保存图片设置':'保存镜头设置';
  syncShotSettingsFeedback();
  state.editing=true;
  dialog.showModal();dialog.querySelector('.shot-settings-body').scrollTop=0;
  dialog.querySelector('[name="title"]').focus({preventScroll:true});
}

/** 刷新只读区域；候选回流不替换表单、选区或滚动位置。 */
function refreshShotSettings(){
  /** 身份不再匹配时关闭旧弹窗，不把它重解释为新镜头。 */
  const dialog=document.getElementById('shot-settings-dialog');
  if(!dialog.open)return;
  if(dialog.dataset.projectId!==state.projectId||dialog.dataset.shotId!==state.shotId){dialog.close();return;}
  const selected=shot();
  /** 保留用户展开/收起状态，异步候选回流不改变辅助区域的布局选择。 */
  const assetsRegion=dialog.querySelector('.shot-settings-assets-region');
  const versionsRegion=dialog.querySelector('.shot-settings-versions-region');
  assetsRegion.innerHTML=renderShotSettingsAssets(selected,assetsRegion.querySelector('details').open);
  versionsRegion.innerHTML=renderShotSettingsVersions(selected,versionsRegion.querySelector('details').open);
  /** 无未保存修改时可跟随候选采用推进基线；脏草稿不能静默重绑定。 */
  if(!shotDraftDirty())dialog.querySelector('#shot-edit-form').dataset.version=selected.version;
}

/** 恢复已保存的字段，只替换当前表单，版本与资产区域保留。 */
function resetShotSettings(){
  shotDrafts.set(`${state.projectId}/${shot().id}`,shotEditValues(shot()));
  document.getElementById('shot-edit-form').outerHTML=renderShotSettingsForm(shot());
  syncShotSettingsFeedback();
  document.querySelector('#shot-edit-form [name="title"]').focus({preventScroll:true});
}

/** 关闭弹窗解除编辑态，保留脏草稿；空草稿移除，避免阻断后续候选采用。 */
document.getElementById('shot-settings-dialog').addEventListener('close',event=>{
  /** 使用打开时身份清理草稿，关闭回调不读取后来切换的镜头。 */
  const dialog=event.currentTarget;
  const current=projects.find(item=>item.id===dialog.dataset.projectId);
  const selected=current?.shots.find(item=>item.id===dialog.dataset.shotId);
  if(selected&&!shotDraftDirty(current,selected))shotDrafts.delete(`${current.id}/${selected.id}`);
  state.editing=false;
  dialog.querySelector('.shot-settings-body').innerHTML='';
  document.querySelector('[data-action="edit-shot"]')?.focus({preventScroll:true});
});

/** 点击弹窗外遮罩关闭；弹窗内部留白不作为关闭区域。 */
document.getElementById('shot-settings-dialog').addEventListener('click',event=>{
  /** 原生 dialog 的遮罩事件目标仍是 dialog，需要结合坐标区分内部空白。 */
  const bounds=event.currentTarget.getBoundingClientRect();
  if(event.target===event.currentTarget&&(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom))event.currentTarget.close();
});
