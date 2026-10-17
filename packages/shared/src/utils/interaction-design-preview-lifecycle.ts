/** 先行桥中的生命周期代码；仅使用已捕获的宿主身份，不请求额外沙箱权限。 */
export const prototypeLifecycleScript = String.raw`
    // 活动标记由宿主控制；离线导出缺省保持运行。
    let active=config.active!==false;
    // 只有明确设置 active 的受管缓存页安装生命周期；离线导出完全保留原生调度。
    const enabled=typeof config.active==='boolean';
    // 原生调度入口与单调时钟，避免页面覆盖后影响暂停恢复。
    const nativeTimeout=window.setTimeout?.bind(window),nativeClear=window.clearTimeout?.bind(window);
    const nativeFrame=window.requestAnimationFrame?.bind(window),nativeCancel=window.cancelAnimationFrame?.bind(window);
    const now=()=>window.performance.now();
    // 任务使用自己的共享 ID 空间，clearTimeout 与 clearInterval 可互换。
    const tasks=new Map();let nextTask=0;
    // 为单个任务安排一次后续执行；隐藏期间不注册原生定时器。
    const arm=task=>{
      if(!active||task.native!==null||!tasks.has(task.id))return;
      task.started=now();
      const fire=stamp=>{
        task.native=null;
        if(!active||!tasks.has(task.id))return;
        if(task.kind!=='interval')tasks.delete(task.id);
        else task.remaining=task.delay;
        try{if(typeof task.callback==='function')Reflect.apply(task.callback,window,task.kind==='frame'?[stamp]:task.args);else window.eval(String(task.callback))}
        finally{if(task.kind==='interval')arm(task)}
      };
      task.native=task.kind==='frame'?nativeFrame(fire):nativeTimeout(fire,task.remaining);
    };
    // 输入回调、延迟与参数，返回可取消的逻辑任务 ID。
    const schedule=(kind,callback,delay,args)=>{
      const duration=Math.max(kind==='interval'?1:0,Math.min(2147483647,Number(delay)||0));
      const task={id:++nextTask,kind,callback,args,delay:duration,remaining:duration,started:0,native:null};
      tasks.set(task.id,task);arm(task);return task.id;
    };
    // 取消逻辑任务及其原生等待，两个定时器清理 API 使用同一实现。
    const clear=(id,frame)=>{const task=tasks.get(Number(id));if(!task||(task.kind==='frame')!==frame)return;if(task.native!==null)(task.kind==='frame'?nativeCancel:nativeClear)(task.native);tasks.delete(task.id)};
    if(enabled&&nativeTimeout&&nativeClear){
      window.setTimeout=(callback,delay,...args)=>schedule('timeout',callback,delay,args);
      window.setInterval=(callback,delay,...args)=>schedule('interval',callback,delay,args);
      window.clearTimeout=window.clearInterval=id=>clear(id,false);
    }
    if(enabled&&nativeFrame&&nativeCancel){window.requestAnimationFrame=callback=>schedule('frame',callback,0,[]);window.cancelAnimationFrame=id=>clear(id,true)}
    // 仅恢复桥主动暂停的动画与媒体，保留用户原先的暂停状态。
    const animations=new Set(),media=new Set();
    const pauseVisuals=()=>{
      if(active)return;
      for(const animation of document.getAnimations?.()||[]){if(animation.playState==='running'){animations.add(animation);animation.pause()}}
      for(const item of document.querySelectorAll?.('audio,video')||[]){if(!item.paused&&!item.ended){media.add(item);item.pause()}}
    };
    // 输入可见性布尔值；相同状态不重新计算剩余时间。
    const setActive=value=>{
      if(value===active)return;
      active=value;
      if(!active){
        observer?.observe(document,{childList:true,subtree:true});
        for(const task of tasks.values())if(task.native!==null){
          (task.kind==='frame'?nativeCancel:nativeClear)(task.native);task.native=null;
          if(task.kind!=='frame')task.remaining=Math.max(0,task.remaining-(now()-task.started));
        }
        pauseVisuals();
      }else{
        observer?.disconnect();
        for(const task of tasks.values())arm(task);
        for(const animation of animations){if(animation.playState==='paused')animation.play()}animations.clear();
        for(const item of media){if(item.isConnected&&item.paused){const result=item.play();result?.catch(()=>{})}}media.clear();
      }
    };
    // 动态正文、CSS 动画和媒体播放在隐藏期间也纳入暂停。
    if(enabled){on('DOMContentLoaded',pauseVisuals);on('animationstart',pauseVisuals);on('transitionrun',pauseVisuals);on('play',pauseVisuals)}
    // 仅隐藏页观察 DOM，避免活动页的日常渲染产生额外回调。
    const observer=!enabled||typeof MutationObserver==='undefined'?null:new MutationObserver(pauseVisuals);
    if(!active)observer?.observe(document,{childList:true,subtree:true});
    if(enabled)on('message',e=>{if(e.source!==host||!e.data||e.data.token!==config.token||e.data.type!=='prototype-visibility'||typeof e.data.active!=='boolean')return;setActive(e.data.active);cancel(e)});
`
