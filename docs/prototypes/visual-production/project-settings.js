/* 项目页展示已保存摘要，创作表单只在独立弹窗中挂载，避免挤压集数入口。 */
'use strict';

/** 根据 current 返回作品目标摘要 HTML；草稿只显示提示，不提前替换正式设定。 */
function renderSettingsSummary(current){
  /** 图片项目仅显示画面规格，声音字段只对视频项目有意义。 */
  const isImage=current.kind==='图片';
  return `<article class="creative-settings-summary"><header><h3>作品目标</h3><span class="creative-summary-draft" ${settingsDirty(current)?'':'hidden'}>有未保存修改</span><button class="button" data-action="open-creative-settings" aria-haspopup="dialog" aria-controls="creative-settings-dialog">${icon('edit')}编辑设定</button></header>
    <p class="creative-summary-brief">${esc(current.brief)}</p>
    <dl class="creative-summary-meta"><div><dt>画面规格</dt><dd>${esc(current.ratio)}${isImage?'':` · ${current.fps} fps`}</dd></div>${isImage?'':`<div><dt>配音风格</dt><dd>${esc(current.voice||'未设置')}</dd></div><div><dt>音乐方向</dt><dd>${esc(current.music||'未设置')}</dd></div>`}</dl></article>`;
}

/** 无入参；同步当前项目的保存反馈和重置按钮，不重建正在输入的表单。 */
function syncProjectSettingsFeedback(){
  /** 显式保存前只展示草稿状态；成功保存信息按影像项目隔离。 */
  const dirty=settingsDirty(project());
  const feedback=document.getElementById('creative-settings-feedback');
  feedback.textContent=dirty?'有未保存的修改':settingsFeedback.get(state.projectId)||'设定用于本项目的后续制作';
  feedback.classList.toggle('is-dirty',dirty);
  document.querySelector('[data-action="reset-settings"]').hidden=!dirty;
}

/** 无入参；打开当前项目的表单，复用该项目此前未保存的草稿。 */
function openProjectSettings(){
  /** 冻结项目身份，后台回流不能将弹窗重新解释为其他影像项目。 */
  const dialog=document.getElementById('creative-settings-dialog');
  dialog.dataset.projectId=state.projectId;
  dialog.querySelector('.creative-dialog-body').innerHTML=renderSettingsForm(project());
  syncProjectSettingsFeedback();
  dialog.showModal();
  dialog.querySelector('.creative-dialog-body').scrollTop=0;
  dialog.querySelector('[name="title"]').focus({preventScroll:true});
}

/** 无入参；主页面刷新时仅核对身份，保留弹窗表单、选区和滚动位置。 */
function refreshProjectSettingsDialog(){
  /** 项目或模块改变时关闭原弹窗，草稿仍由原项目持有。 */
  const dialog=document.getElementById('creative-settings-dialog');
  if(dialog.open&&(dialog.dataset.projectId!==state.projectId||state.workspaceTab!=='visual'||state.productionStep!=='project'||!state.workspaceOpen))dialog.close();
}

/** 点击摘要入口或弹窗关闭按钮；其他模块动作仍交给原事件处理器。 */
document.addEventListener('click',event=>{
  /** 使用最近的动作按钮，允许点击按钮内的图标。 */
  const action=event.target instanceof Element?event.target.closest('[data-action]')?.dataset.action:null;
  if(action==='open-creative-settings')openProjectSettings();
  if(action==='close-creative-settings')document.getElementById('creative-settings-dialog').close();
});

/** 关闭后保留草稿，更新摘要提示并恢复编辑入口焦点。 */
document.getElementById('creative-settings-dialog').addEventListener('close',event=>{
  /** 原生关闭事件异步触发；已重新打开时不清空新表单。 */
  const dialog=event.currentTarget;
  if(dialog.open)return;
  dialog.querySelector('.creative-dialog-body').innerHTML='';
  if(dialog.dataset.projectId!==state.projectId)return;
  /** 仅更新摘要卡片，保留集数和 Agent 对话的滚动位置。 */
  const summary=document.querySelector('.creative-settings-summary');
  if(summary)summary.outerHTML=renderSettingsSummary(project());
  document.querySelector('[data-action="open-creative-settings"]')?.focus({preventScroll:true});
});

/** 点击遮罩关闭；弹窗内部的留白和固定底栏不触发关闭。 */
document.getElementById('creative-settings-dialog').addEventListener('click',event=>{
  /** 原生遮罩仍以 dialog 为事件目标，坐标用于区分实际点击区域。 */
  const bounds=event.currentTarget.getBoundingClientRect();
  if(event.target===event.currentTarget&&(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom))event.currentTarget.close();
});
