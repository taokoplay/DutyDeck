import { getPrototypeSafeArea } from './interaction-design-device-profile'

/**
 * 显式移动布局运行时；嵌入既有预览先行桥，复用 config/host/on/cancel 的受控消息边界。
 * 只调整标记容器和三个根属性，不强制 body 留白，不创建业务导航，不开启轮询。
 */
export const prototypePresentationScript = String.raw`
    {
      // 预览和开发交接执行同一安全区函数，切换状态栏时不会残留上一次顶部占位。
      const effectiveSafeArea=(${getPrototypeSafeArea.toString()});
      // 当前设备参数由宿主提供；在正文就绪前收到的更新只替换此快照。
      let viewport=config.viewport,renderPresentation;
      on('message',e=>{
        if(e.source!==host||e.data?.type!=='prototype-viewport'||e.data.token!==config.token)return;
        cancel(e);
        const next=e.data.viewport;
        if(!next||!['ios','android','web'].includes(next.target)||!['portrait','landscape'].includes(next.orientation))return;
        const dimension=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=4096;
        if(!dimension(next.width)||!dimension(next.height)||next.width<1||next.height<1||!dimension(next.statusBarHeight)||!next.safeArea||!['top','right','bottom','left'].every(side=>dimension(next.safeArea[side])))return;
        if(next.cutout&&!['top','left','width','height','radius'].every(key=>dimension(next.cutout[key])))return;
        viewport=next;renderPresentation?.();
      });
      on('DOMContentLoaded',()=>{
        // 根导航模式与业务导航标记分开命名，避免页面导航样式误匹配整个html。
        const root=document.documentElement;
        root.setAttribute('data-prototype-layout',config.presentation.contentLayout);
        root.setAttribute('data-prototype-status-bar',config.presentation.statusBar);
        root.setAttribute('data-prototype-navigation-mode',config.presentation.navigation);
        const style=document.createElement('style');
        style.textContent="\n          [data-prototype-shell]{box-sizing:border-box;min-height:100dvh;position:relative}\n          html[data-prototype-layout=\"safe\"] [data-prototype-shell]{padding:var(--prototype-safe-top) var(--prototype-safe-right) var(--prototype-safe-bottom) var(--prototype-safe-left)}\n          html[data-prototype-layout=\"edge-to-edge\"] [data-prototype-shell]{padding:0}\n          [data-prototype-safe-controls]{position:absolute;inset:var(--prototype-safe-top) var(--prototype-safe-right) var(--prototype-safe-bottom) var(--prototype-safe-left);pointer-events:none;box-sizing:border-box}\n          [data-prototype-safe-controls]>*{pointer-events:auto}\n          [data-prototype-navigation]{box-sizing:border-box;min-height:44px;align-items:center}\n          html[data-prototype-navigation-mode=\"overlay\"] [data-prototype-navigation]{position:absolute;z-index:10;top:var(--prototype-safe-top);left:var(--prototype-safe-left);right:var(--prototype-safe-right)}\n          html[data-prototype-navigation-mode=\"none\"] [data-prototype-navigation]{display:none!important}\n          html body [data-prototype-system-chrome]{display:block;position:fixed;inset:0;pointer-events:none;z-index:2147483000;font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif}\n          html body [data-prototype-system-status]{box-sizing:border-box;position:absolute;top:0;left:0;right:0;display:flex;align-items:center;justify-content:space-between;line-height:1;font-weight:600;letter-spacing:0;color:var(--prototype-status-color);pointer-events:none}\n          html body [data-prototype-system-status] span{display:flex;align-items:center;gap:5px}\n          html body [data-prototype-system-status] svg{display:block;width:64px;height:14px;fill:currentColor}\n          html body [data-prototype-system-home]{position:absolute;bottom:8px;left:50%;width:120px;height:5px;transform:translateX(-50%);border-radius:99px;background:#fff;pointer-events:none}\n          html body [data-prototype-system-cutout]{position:absolute;background:#000;pointer-events:none}\n        ";
        document.head.append(style);
        // 系统图标只生成一次；9:41为固定演示时间，无计时器或网络依赖。
        const chrome=document.createElement('div');chrome.setAttribute('data-prototype-system-chrome','');chrome.setAttribute('aria-hidden','true');
        const status=document.createElement('div');status.setAttribute('data-prototype-system-status','');
        status.innerHTML='<span>9:41</span><span><svg viewBox="0 0 66 14" aria-hidden="true"><path d="M1 10h3v3H1zm5-3h3v6H6zm5-3h3v9h-3zm5-3h3v12h-3z"/><path d="M24 5a11 11 0 0 1 16 0l-2 2a8 8 0 0 0-12 0zm3 3a7 7 0 0 1 10 0l-2 2a4 4 0 0 0-6 0zm4 3a2 2 0 0 1 2 0l-1 2z"/><rect x="45" y="2" width="17" height="10" rx="2" fill="none" stroke="currentColor"/><rect x="47" y="4" width="13" height="6" rx="1"/><path d="M64 5h2v4h-2z"/></svg></span>';
        const home=document.createElement('div');home.setAttribute('data-prototype-system-home','');
        const cutout=document.createElement('div');cutout.setAttribute('data-prototype-system-cutout','');
        chrome.append(status,home);if(config.simulateHardware)chrome.append(cutout);document.body.append(chrome);
        renderPresentation=()=>{
          // 几何和可见性相互独立：隐藏状态栏仍保留硬件遮挡与控件避让参数。
          const appearance=root.getAttribute('data-prototype-status-bar');
          const visible=viewport.target!=='web'&&appearance!=='hidden'&&viewport.statusBarHeight>0;
          const area=effectiveSafeArea(viewport,appearance);
          for(const side of ['top','right','bottom','left'])root.style.setProperty('--prototype-safe-'+side,area[side]+'px');
          root.style.setProperty('--prototype-status-color',appearance==='light'?'#fff':'#111');
          root.style.setProperty('--prototype-viewport-width',viewport.width+'px');root.style.setProperty('--prototype-viewport-height',viewport.height+'px');
          status.style.display=visible?'flex':'none';status.style.height=viewport.statusBarHeight+'px';
          status.style.fontSize=viewport.statusBarHeight<=24?'12px':'15px';
          // 右置摄像头（Duo）需要单独让出图标空间，其余设备沿用两侧对齐。
          const rightCamera=viewport.cutout&&viewport.cutout.top<viewport.height*.2&&viewport.cutout.left>viewport.width*.7?viewport.width-viewport.cutout.left+12:0;
          status.style.paddingLeft=Math.max(24,area.left)+'px';status.style.paddingRight=Math.max(24,area.right,rightCamera)+'px';
          home.style.display=viewport.homeIndicator&&viewport.target!=='web'?'block':'none';home.style.width=viewport.target==='android'?'104px':'120px';
          // 固定系统层无法可靠混合页面背景；页面也可用CSS变量显式指定手势条颜色。
          home.style.background='var(--prototype-home-color,'+(appearance==='dark'?'#111':'#fff')+')';
          cutout.style.display=config.simulateHardware&&viewport.cutout?'block':'none';
          if(viewport.cutout)for(const key of ['top','left','width','height'])cutout.style[key]=viewport.cutout[key]+'px';
          if(viewport.cutout)cutout.style.borderRadius=viewport.cutout.radius+'px';
        };
        renderPresentation();
        // 只观察布局属性，设备切换写入style不会触发循环，也不扫描业务DOM。
        new MutationObserver(renderPresentation).observe(root,{attributes:true,attributeFilter:['data-prototype-layout','data-prototype-status-bar','data-prototype-navigation-mode']});
      });
    }
`
