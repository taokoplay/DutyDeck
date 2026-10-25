/** 原型的唯一状态容器；媒体采用与声音文字只在内存中模拟，不调用业务 API。 */
const state = {
  /** 当前镜头下标。 */
  index: 0,
  /** 首镜影片的模拟采用状态，与画面状态完全独立。 */
  videoAdopted: false,
  /** 首镜示例画面的模拟采用状态。 */
  imageAdopted: false,
  /** 当前候选窗口只对应一种输出。 */
  candidateKind: 'video',
  /** 每个镜头独立保存的声音设计文字。 */
  audio: SHOTS.map((shot, index) => ({
    dialogue: shot.dialogue,
    fx: index === 0 ? '雨声、记录仪提示音、白光冲击' : '',
    music: index === 0 ? '克制的低频氛围，不盖过对白' : '',
  })),
};
/** 用固定 ID 取得原型元素；入参是元素 ID，返回对应 DOM 节点。 */
function byId(id) { return document.getElementById(id); }
/** 主舞台播放器，镜头切换和弹窗共用这个播放实例。 */
const mainVideo = byId('main-video');
/** 原生候选弹窗负责焦点约束和 Escape 关闭。 */
const candidateDialog = byId('candidate-dialog');
/** 最后一次提示的计时器，连续操作时覆盖旧提示。 */
let toastTimer;

/** 把秒数格式化为 mm:ss；返回播放器可读时间。 */
function formatTime(seconds) {
  /** 不可用的媒体时长视为零。 */
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}
/** 更新按钮图标；name 必须来自页面内预定义的 SVG symbol。 */
function setIcon(button, name) { button.querySelector('use').setAttribute('href', `#i-${name}`); }
/** 显示短暂操作结果；入参为用户可见文字，不修改作品内容。 */
function notify(message) {
  clearTimeout(toastTimer);
  byId('toast').textContent = message;
  byId('toast').hidden = false;
  toastTimer = setTimeout(() => { byId('toast').hidden = true; }, 3500);
}
/** 返回当前模拟采用的静帧路径，影片路径始终独立。 */
function currentImage() { return state.index === 0 && state.imageAdopted ? 'assets/frame-example.jpg' : SHOTS[state.index].image; }
/** 停止所有影片；用于打开弹窗、切换镜头及页面不可见时。 */
function pauseAll() { document.querySelectorAll('video').forEach(video => video.pause()); }
/** 同步主舞台播放按钮与计时；实际播放状态以 HTMLVideoElement 为准。 */
function syncPlayback() {
  /** 目前仅首镜有真实影片，其他镜头显示明确空状态。 */
  const available = state.index === 0;
  /** 暂停和结束均显示播放按钮。 */
  const paused = mainVideo.paused || mainVideo.ended;
  byId('stage-play').hidden = !available || !paused;
  setIcon(byId('play'), paused ? 'play' : 'pause');
  byId('play').setAttribute('aria-label', paused ? '播放影片' : '暂停影片');
  byId('elapsed').textContent = formatTime(available ? mainVideo.currentTime : 0);
  byId('total').textContent = available ? formatTime(mainVideo.duration || 6) : '--:--';
  byId('seek').value = available ? mainVideo.currentTime : 0;
  byId('seek').max = available && Number.isFinite(mainVideo.duration) ? mainVideo.duration : 6.04;
  for (const id of ['play', 'seek', 'mute', 'fullscreen']) byId(id).disabled = !available;
}
/** 根据用户播放动作切换主影片；解码失败明确提示。 */
async function togglePlayback() {
  if (state.index !== 0) return;
  if (!mainVideo.paused) { mainVideo.pause(); return; }
  try { await mainVideo.play(); }
  catch { notify('影片暂时无法播放，请通过本地预览地址打开页面。'); }
}
/** 构建镜头序列的静态按钮；入参为只读镜头数据与下标，返回可操作按钮。 */
function createShotButton(shot, index) {
  /** 缩略图与标签按语义分离，动态文字使用 textContent 写入。 */
  const button = document.createElement('button');
  button.className = 'shot-button';
  button.type = 'button';
  button.innerHTML = '<div class="shot-thumbnail"><img alt="" loading="lazy"><span></span><time></time></div><div class="shot-caption"><strong></strong><small></small></div>';
  button.querySelector('img').src = shot.image;
  button.querySelector('.shot-thumbnail>span').textContent = String(index + 1).padStart(2, '0');
  button.querySelector('time').textContent = `${shot.duration}s`;
  button.querySelector('strong').textContent = shot.title;
  button.addEventListener('click', () => selectShot(index));
  return button;
}
SHOTS.forEach((shot, index) => byId('shot-list').append(createShotButton(shot, index)));

/** 仅刷新显示信息，不触发自动播放，也不读取新的作品数据。 */
function renderShot() {
  /** 当前只读镜头的描述与正式静帧。 */
  const shot = SHOTS[state.index];
  /** 首镜使用真实影片，其余镜头有静帧但没有影片。 */
  const hasVideo = state.index === 0;
  /** 镜头编号在标题、页脚与导航共用。 */
  const number = String(state.index + 1).padStart(2, '0');
  byId('shot-title').textContent = shot.title;
  byId('shot-number').textContent = number;
  byId('shot-duration').textContent = `${shot.duration} 秒`;
  byId('shot-position').textContent = `${number} / 06`;
  byId('foot-shot').textContent = number;
  byId('previous').disabled = state.index === 0;
  byId('next').disabled = state.index === SHOTS.length - 1;
  byId('scene-text').textContent = shot.scene;
  byId('motion-text').textContent = shot.motion;
  byId('quote-text').textContent = shot.dialogue;
  byId('reference-image').src = currentImage();
  byId('image-name').textContent = state.index === 0 && state.imageAdopted ? '已采用示例画面' : '构图与起始关键帧';
  byId('image-count').textContent = state.index === 0 && !state.imageAdopted ? '1' : '0';
  byId('image-compare').hidden = state.index !== 0;
  byId('image-candidates').disabled = state.index !== 0;
  byId('film-empty').hidden = hasVideo;
  mainVideo.hidden = !hasVideo;
  byId('stage-version').textContent = hasVideo ? state.videoAdopted ? '当前已采用影片' : '影片候选 01' : `镜头 ${number}`;
  byId('stage-spec').hidden = !hasVideo;
  byId('film-status').className = `status ${hasVideo ? state.videoAdopted ? 'adopted' : 'pending' : ''}`;
  byId('film-status').replaceChildren();
  byId('film-status').append(document.createElement('i'), hasVideo ? state.videoAdopted ? '已采用影片' : '候选预览 · 待采用' : '尚无影片');
  byId('film-candidate-row').hidden = !hasVideo;
  byId('video-count').textContent = state.videoAdopted ? '已采用' : '1';
  byId('adopt-video').disabled = state.videoAdopted;
  byId('adopt-video').lastChild.textContent = state.videoAdopted ? '已采用' : '采用影片';
  byId('overview-video').textContent = hasVideo ? state.videoAdopted ? '已采用' : '1 个候选' : '未生成';
  byId('overview-image').textContent = state.index === 0 && state.imageAdopted ? '已采用示例画面' : '已采用';
  byId('dialogue-line').textContent = state.audio[state.index].dialogue || '尚未填写对白要求';
  byId('fx-line').textContent = state.audio[state.index].fx || '尚未填写环境与音效要求';
  byId('music-line').textContent = state.audio[state.index].music || '尚未填写配乐要求';
  byId('shot-list').querySelectorAll('button').forEach((button, index) => {
    /** 序列只展示影片的制作状态，静帧不会被误认为已生成影片。 */
    const status = index === 0 ? state.videoAdopted ? '影片已采用' : '1 个影片候选' : '画面就绪 · 待制作影片';
    button.setAttribute('aria-pressed', String(index === state.index));
    button.setAttribute('aria-label', `镜头 ${index + 1}，${SHOTS[index].title}，${status}`);
    button.querySelector('small').textContent = status;
  });
  syncPlayback();
}
/** 切换镜头并暂停主影片；越界请求安全忽略。 */
function selectShot(index) {
  if (index < 0 || index >= SHOTS.length) return;
  pauseAll();
  state.index = index;
  mainVideo.currentTime = 0;
  renderShot();
  /** 横排镜头条仅调整自身滚动，避免把主预览推离视口。 */
  const strip = byId('shot-list');
  /** 选中镜头在横排容器中的实际位置。 */
  const selected = strip.children[index];
  if (strip.scrollWidth > strip.clientWidth) {
    /** 页面坐标的差值只用于计算容器横向偏移。 */
    const stripBounds = strip.getBoundingClientRect();
    /** 按钮的屏幕位置不会用于触发其它 UI 操作。 */
    const selectedBounds = selected.getBoundingClientRect();
    if (selectedBounds.left < stripBounds.left) strip.scrollLeft += selectedBounds.left - stripBounds.left;
    else if (selectedBounds.right > stripBounds.right) strip.scrollLeft += selectedBounds.right - stripBounds.right;
  }
}
/** 为比较区创建一个媒体元素；入参是种类与相对路径，返回元素。 */
function createMedia(kind, source) {
  /** 视频只有用户主动点击才播放，图片始终只是画面预览。 */
  const element = document.createElement(kind === 'video' ? 'video' : 'img');
  element.src = source;
  if (kind === 'video') { element.controls = true; element.playsInline = true; element.preload = 'metadata'; element.poster = 'assets/shot-01.jpg'; }
  else element.alt = '候选画面预览';
  return element;
}
/** 打开指定媒体类型的候选窗口；返回值为空，采用动作只改变该类型状态。 */
function openCandidate(kind) {
  if (state.index !== 0) return;
  pauseAll();
  state.candidateKind = kind;
  /** 当前窗口的可读类型名称。 */
  const label = kind === 'video' ? '影片' : '画面';
  /** 当前类型的采用状态，不从其他输出推断。 */
  const adopted = kind === 'video' ? state.videoAdopted : state.imageAdopted;
  byId('candidate-overline').textContent = `${label}候选`;
  byId('candidate-title').textContent = SHOTS[0].title;
  byId('candidate-kind').textContent = `${label}候选 01${adopted ? ' · 已采用' : ''}`;
  byId('candidate-note').textContent = kind === 'video' ? '仅采用影片，画面与音频保持不变' : '仅采用画面，影片与音频保持不变';
  byId('proposed-label').textContent = `本次${label}候选`;
  byId('current-output-body').replaceChildren();
  if (kind === 'image') byId('current-output-body').append(createMedia('image', currentImage()));
  else if (adopted) byId('current-output-body').append(createMedia('video', 'assets/shot-01.mp4'));
  else byId('current-output-body').innerHTML = '<div class="compare-empty"><svg><use href="#i-film"/></svg><span>尚未采用影片</span><p>采用后将用于本镜正式预览</p></div>';
  byId('proposed-output-body').replaceChildren(createMedia(kind, kind === 'video' ? 'assets/shot-01.mp4' : 'assets/frame-example.jpg'));
  byId('candidate-summary').textContent = kind === 'video' ? '缓推近景 · 单次白光' : '构图备选 · 交互示例';
  byId('candidate-description').textContent = kind === 'video' ? '真实首镜影片，约 6 秒，576 × 1024，24 fps。可在此单独检查影片并模拟采用；静态画面保持原有选择。' : '本图取自首镜影片抽帧，仅用于演示画面候选的独立比较与采用，不代表新生成的图片候选。';
  byId('dialog-adopt').lastChild.textContent = adopted ? `已采用${label}` : `采用${label}`;
  byId('dialog-adopt').disabled = adopted;
  candidateDialog.showModal();
}
/** 单独采用一类输出；不修改另外两类，也不写磁盘或服务。 */
function adopt(kind) {
  if (kind === 'video') state.videoAdopted = true;
  else state.imageAdopted = true;
  if (candidateDialog.open) candidateDialog.close();
  renderShot();
  notify(kind === 'video' ? '已模拟采用影片，画面与声音保持不变。' : '已模拟采用画面，影片与声音保持不变。');
}

byId('previous').addEventListener('click', () => selectShot(state.index - 1));
byId('next').addEventListener('click', () => selectShot(state.index + 1));
byId('play').addEventListener('click', togglePlayback);
byId('stage-play').addEventListener('click', togglePlayback);
mainVideo.addEventListener('click', togglePlayback);
for (const eventName of ['play', 'pause', 'ended', 'loadedmetadata', 'timeupdate']) mainVideo.addEventListener(eventName, syncPlayback);
byId('seek').addEventListener('input', event => { mainVideo.currentTime = Number(event.target.value); syncPlayback(); });
byId('mute').addEventListener('click', () => { mainVideo.muted = !mainVideo.muted; setIcon(byId('mute'), mainVideo.muted ? 'muted' : 'volume'); byId('mute').setAttribute('aria-label', mainVideo.muted ? '取消静音' : '静音'); });
byId('fullscreen').addEventListener('click', async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await mainVideo.requestFullscreen(); }
  catch { notify('当前浏览器不支持全屏，可放大预览窗口查看。'); }
});
/** 原生全屏时启用原生媒体控制条，退出后交回页面控制条。 */
document.addEventListener('fullscreenchange', () => { mainVideo.controls = document.fullscreenElement === mainVideo; });
byId('video-candidate').addEventListener('click', () => openCandidate('video'));
byId('image-candidates').addEventListener('click', () => openCandidate('image'));
byId('image-compare').addEventListener('click', () => openCandidate('image'));
byId('adopt-video').addEventListener('click', () => adopt('video'));
byId('dialog-adopt').addEventListener('click', () => adopt(state.candidateKind));
byId('open-image').addEventListener('click', () => { pauseAll(); byId('large-image').src = currentImage(); byId('image-dialog-title').textContent = `${SHOTS[state.index].title} · 已采用画面`; byId('image-dialog').showModal(); });
byId('audio-design').addEventListener('click', () => {
  pauseAll();
  byId('audio-dialog-title').textContent = SHOTS[state.index].title;
  byId('audio-dialogue').value = state.audio[state.index].dialogue;
  byId('audio-fx').value = state.audio[state.index].fx;
  byId('audio-music').value = state.audio[state.index].music;
  byId('audio-dialog').showModal();
});
byId('audio-form').addEventListener('submit', event => {
  event.preventDefault();
  state.audio[state.index] = { dialogue: byId('audio-dialogue').value.trim(), fx: byId('audio-fx').value.trim(), music: byId('audio-music').value.trim() };
  byId('audio-dialog').close(); renderShot(); notify('声音设计已保存到本次预览。');
});
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('close', () => { dialog.querySelectorAll('video').forEach(video => video.pause()); }));
/** 捕获所有视频播放事件，保证预览与候选对比之间始终只有一个声音来源。 */
document.addEventListener('play', event => { if (event.target instanceof HTMLVideoElement) document.querySelectorAll('video').forEach(video => { if (video !== event.target) video.pause(); }); }, true);
document.addEventListener('visibilitychange', () => { if (document.hidden) pauseAll(); });
byId('theme-toggle').addEventListener('click', () => {
  /** 主题仅影响原型页面，不修改系统或应用设置。 */
  const light = document.documentElement.dataset.theme !== 'light';
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  byId('theme-toggle').setAttribute('aria-label', light ? '切换深色主题' : '切换浅色主题');
  setIcon(byId('theme-toggle'), light ? 'moon' : 'sun');
});
byId('compact-toggle').addEventListener('click', () => {
  /** 紧凑模式验证右侧小面板下的影片优先布局。 */
  const compact = byId('studio').classList.toggle('compact');
  byId('compact-toggle').setAttribute('aria-pressed', String(compact));
  byId('compact-toggle').textContent = compact ? '宽面板' : '窄面板';
});
byId('reset').addEventListener('click', () => {
  state.videoAdopted = false; state.imageAdopted = false;
  state.audio = SHOTS.map((shot, index) => ({ dialogue: shot.dialogue, fx: index === 0 ? '雨声、记录仪提示音、白光冲击' : '', music: index === 0 ? '克制的低频氛围，不盖过对白' : '' }));
  selectShot(0); notify('已恢复预览初始状态。');
});
renderShot();
