// 离线规划演示数据：四类作品、镜头候选与锁定资产；不触发真实生成或网络请求。
window.STUDIO_DATA = {
  "projects": [
    {
      "id": "promo",
      "kind": "宣传片",
      "title": "LUMA · 把光带向生活",
      "subtitle": "随行灯品牌短片 / 36 秒",
      "brief": "以「光随生活而行」为主线，用晨间书桌、夜读与露营串起随行灯的使用情境。保持米白灯体、冷蓝环境和暖光灯头一致，不虚构参数与功能。",
      "ratio": "16:9",
      "fps": 24,
      "voice": "温暖、克制的女声",
      "music": "轻盈钢琴与柔和环境音",
      "shots": [
        {
          "id": "p1",
          "title": "晨光启幕",
          "duration": 6,
          "scene": "清晨窗边书桌，米白随行灯置于右侧，柔和日光洒过桌面。",
          "motion": "缓慢横移，留出左侧呼吸空间。",
          "dialogue": "光，陪你开始平凡的一天。",
          "image": "assets/promo-1.svg",
          "status": "adopted",
          "version": 1,
          "assetIds": [
            "product",
            "style"
          ],
          "takes": [
            {
              "id": "v1",
              "label": "初版",
              "image": "assets/promo-1.svg"
            }
          ]
        },
        {
          "id": "p2",
          "title": "触见细节",
          "duration": 6,
          "scene": "近距离展示灯罩、提环和米白灯体，保持暖光与材质真实。",
          "motion": "微距推近，焦点从提环落到灯罩。",
          "dialogue": "简单的形状，装得下温暖。",
          "image": "assets/promo-2.svg",
          "status": "adopted",
          "version": 1,
          "assetIds": [
            "product",
            "style"
          ],
          "takes": [
            {
              "id": "v1",
              "label": "初版",
              "image": "assets/promo-2.svg"
            }
          ]
        },
        {
          "id": "p3",
          "title": "夜读时光",
          "duration": 6,
          "scene": "深蓝夜色中，灯光落在展开的书页上，窗外静谧。",
          "motion": "固定中景，轻微推近书页与光晕。",
          "dialogue": "也陪你，把时间留给自己。",
          "image": "assets/promo-3.svg",
          "status": "review",
          "version": 1,
          "assetIds": [
            "product",
            "style"
          ],
          "takes": [
            {
              "id": "v1",
              "label": "初版",
              "image": "assets/promo-3.svg"
            }
          ]
        },
        {
          "id": "p4",
          "title": "带光出发",
          "duration": 6,
          "scene": "山野露营，帐篷旁的随行灯照亮一小片夜色。",
          "motion": "低机位轻缓后拉，带出帐篷与山。",
          "dialogue": "走远一点，光也跟着你。",
          "image": "assets/promo-4.svg",
          "status": "adopted",
          "version": 1,
          "assetIds": [
            "product",
            "style"
          ],
          "takes": [
            {
              "id": "v1",
              "label": "初版",
              "image": "assets/promo-4.svg"
            }
          ]
        },
        {
          "id": "p5",
          "title": "轻松随行",
          "duration": 6,
          "scene": "一只手从上方握住提环，轻轻提起灯体。",
          "motion": "跟随手部上移，灯体外观保持稳定。",
          "dialogue": "提起温暖，继续出发。",
          "image": "assets/promo-5.svg",
          "status": "adopted",
          "version": 1,
          "assetIds": [
            "product",
            "style"
          ],
          "takes": [
            {
              "id": "v1",
              "label": "初版",
              "image": "assets/promo-5.svg"
            }
          ]
        },
        {
          "id": "p6",
          "title": "品牌落版",
          "duration": 6,
          "scene": "米白背景下的产品静物，左侧呈现 LUMA 品牌。",
          "motion": "固定镜头，收尾留白两秒。",
          "dialogue": "LUMA，把光带向生活。",
          "image": "assets/promo-6.svg",
          "status": "adopted",
          "version": 1,
          "assetIds": [
            "product",
            "style"
          ],
          "takes": [
            {
              "id": "v1",
              "label": "初版",
              "image": "assets/promo-6.svg"
            }
          ]
        }
      ],
      "assets": [
        {
          "id": "product",
          "name": "LUMA 随行灯",
          "type": "产品",
          "version": 1,
          "locked": true,
          "image": "assets/promo-2.svg",
          "description": "米白灯体、半透明暖光灯罩、圆弧提环；全片外观锁定。"
        },
        {
          "id": "style",
          "name": "冷蓝 × 暖光",
          "type": "风格",
          "version": 1,
          "locked": true,
          "image": "assets/promo-3.svg",
          "description": "克制的蓝灰环境、米白材质和柔和暖光，避免高饱和色。"
        },
        {
          "id": "brand",
          "name": "LUMA 品牌基线",
          "type": "品牌",
          "version": 1,
          "locked": true,
          "image": "assets/promo-6.svg",
          "description": "示例虚构品牌；落版统一使用 LUMA 与「把光，带向生活」。"
        }
      ]
    },
    {
      "id": "comic",
      "kind": "漫剧",
      "title": "雾港来信 · 第一集",
      "subtitle": "原创悬疑漫剧 / 4 镜",
      "brief": "少女林雾收到一封来自停用灯塔的信，沿雾港寻找寄信人。保持短发、赭色大衣与旧信封一致；第一集以灯塔亮起留下悬念。",
      "ratio": "9:16",
      "fps": 24,
      "voice": "年轻女声，低声叙述",
      "music": "低频氛围与稀疏钢琴",
      "shots": [
        {
          "id": "c1",
          "title": "雾中的信",
          "duration": 9,
          "scene": "林雾站在雾港石阶上，手里握着泛黄信封。",
          "motion": "全景缓慢推进至人物。",
          "dialogue": "那封信，没有寄信人的名字。",
          "image": "assets/comic-1.svg",
          "status": "adopted",
          "version": 1,
          "assetIds": [
            "linwu",
            "harbor"
          ],
          "takes": [
            {
              "id": "v1",
              "label": "初版",
              "image": "assets/comic-1.svg"
            }
          ]
        },
        {
          "id": "c2",
          "title": "旧窗与字迹",
          "duration": 9,
          "scene": "旧屋窗边，林雾低头看信，赭色衣袖承接暖光。",
          "motion": "侧面中景，轻推信封。",
          "dialogue": "只有一句：天黑之前，到灯塔来。",
          "image": "assets/comic-2.svg",
          "status": "adopted",
          "version": 1,
          "assetIds": [
            "linwu",
            "harbor"
          ],
          "takes": [
            {
              "id": "v1",
              "label": "初版",
              "image": "assets/comic-2.svg"
            }
          ]
        },
        {
          "id": "c3",
          "title": "走向栈桥",
          "duration": 9,
          "scene": "林雾走上通向海面的木栈桥，雾遮住远方。",
          "motion": "背后跟随，压低地平线。",
          "dialogue": "可那座灯塔，已经熄灭了十年。",
          "image": "assets/comic-3.svg",
          "status": "adopted",
          "version": 1,
          "assetIds": [
            "linwu",
            "harbor"
          ],
          "takes": [
            {
              "id": "v1",
              "label": "初版",
              "image": "assets/comic-3.svg"
            }
          ]
        },
        {
          "id": "c4",
          "title": "灯塔再次亮起",
          "duration": 9,
          "scene": "远方灯塔穿透雾气，林雾停在海边。",
          "motion": "从人物侧脸移向远处灯光。",
          "dialogue": "直到那天，它再次亮了起来。",
          "image": "assets/comic-4.svg",
          "status": "adopted",
          "version": 1,
          "assetIds": [
            "linwu",
            "harbor"
          ],
          "takes": [
            {
              "id": "v1",
              "label": "初版",
              "image": "assets/comic-4.svg"
            }
          ]
        }
      ],
      "assets": [
        {
          "id": "linwu",
          "name": "林雾 · 主角",
          "type": "角色",
          "version": 1,
          "locked": true,
          "image": "assets/comic-2.svg",
          "description": "短发、赭色大衣、米色内衬；人物轮廓与服装跨镜头锁定。"
        },
        {
          "id": "harbor",
          "name": "雾港 · 世界设定",
          "type": "场景",
          "version": 1,
          "locked": true,
          "image": "assets/comic-1.svg",
          "description": "蓝灰海港、旧式窗框、石阶与栈桥。"
        },
        {
          "id": "comicstyle",
          "name": "几何叙事插画",
          "type": "风格",
          "version": 1,
          "locked": true,
          "image": "assets/comic-4.svg",
          "description": "几何块面、纸感配色与节制阴影，保持二维绘本风格。"
        }
      ]
    },
    {
      "id": "film",
      "kind": "影片",
      "title": "凌晨四点的海",
      "subtitle": "诗意短片 / 32 秒",
      "brief": "用四个静谧镜头讲述从夜色到日出的等待。以海、灯塔和栈桥构成空间连续性，人物只作尺度参照。",
      "ratio": "16:9",
      "fps": 24,
      "voice": "沉静男声，留足停顿",
      "music": "海浪实录与缓慢弦乐",
      "shots": [
        {
          "id": "f1",
          "title": "四点，海还未醒",
          "duration": 8,
          "scene": "冷蓝夜色中的海面与近处礁石，月亮低悬。",
          "motion": "固定远景，保留海浪运动。",
          "dialogue": "凌晨四点，世界还没有醒来。",
          "image": "assets/film-1.svg",
          "status": "adopted",
          "version": 1,
          "assetIds": [
            "sea",
            "filmstyle"
          ],
          "takes": [
            {
              "id": "v1",
              "label": "初版",
              "image": "assets/film-1.svg"
            }
          ]
        },
        {
          "id": "f2",
          "title": "灯塔守夜",
          "duration": 8,
          "scene": "灯塔立于岸边，光束扫过安静的海面。",
          "motion": "缓慢横移，强调塔与海的尺度。",
          "dialogue": "总有一束光，替我们守着远方。",
          "image": "assets/film-2.svg",
          "status": "adopted",
          "version": 1,
          "assetIds": [
            "sea",
            "filmstyle"
          ],
          "takes": [
            {
              "id": "v1",
              "label": "初版",
              "image": "assets/film-2.svg"
            }
          ]
        },
        {
          "id": "f3",
          "title": "走到尽头",
          "duration": 8,
          "scene": "木栈桥伸向海，一位旅人站在尽头等待。",
          "motion": "沿栈桥中心线缓慢推进。",
          "dialogue": "我走到这里，不是为了离开。",
          "image": "assets/film-3.svg",
          "status": "adopted",
          "version": 1,
          "assetIds": [
            "sea",
            "filmstyle"
          ],
          "takes": [
            {
              "id": "v1",
              "label": "初版",
              "image": "assets/film-3.svg"
            }
          ]
        },
        {
          "id": "f4",
          "title": "第一束晨光",
          "duration": 8,
          "scene": "日出染亮海面，暖色反光铺开，近岸礁石保持暗部。",
          "motion": "固定广角，以光线变化结束。",
          "dialogue": "只是想看见，新的一天。",
          "image": "assets/film-4.svg",
          "status": "adopted",
          "version": 1,
          "assetIds": [
            "sea",
            "filmstyle"
          ],
          "takes": [
            {
              "id": "v1",
              "label": "初版",
              "image": "assets/film-4.svg"
            }
          ]
        }
      ],
      "assets": [
        {
          "id": "sea",
          "name": "海岸空间",
          "type": "场景",
          "version": 1,
          "locked": true,
          "image": "assets/film-1.svg",
          "description": "同一海域的礁石、灯塔与栈桥，地平线连续。"
        },
        {
          "id": "filmstyle",
          "name": "蓝调到日出",
          "type": "风格",
          "version": 1,
          "locked": true,
          "image": "assets/film-4.svg",
          "description": "前段冷蓝低对比，末镜转向柔和暖色。"
        },
        {
          "id": "narrator",
          "name": "沉静旁白",
          "type": "声音",
          "version": 1,
          "locked": true,
          "image": "assets/film-3.svg",
          "description": "低声叙述，短句留白；海浪声优先于配乐。"
        }
      ]
    },
    {
      "id": "image",
      "kind": "图片",
      "title": "LUMA · 品牌视觉套图",
      "subtitle": "产品封面 / 海报 / 详情 / 社交图",
      "brief": "围绕同一随行灯制作四种用途的视觉。锁定产品身份与品牌色，分别调整信息层级和构图，输出前逐张检查文字与外观。",
      "ratio": "1:1",
      "fps": 24,
      "voice": "无旁白",
      "music": "无配乐",
      "shots": [
        {
          "id": "i1",
          "title": "产品封面",
          "duration": 0,
          "scene": "右侧产品、左侧主标题，米白与蓝灰形成安静对比。",
          "motion": "静态构图：主体偏右。",
          "dialogue": "一盏灯，很多种生活。",
          "image": "assets/image-1.svg",
          "status": "review",
          "version": 1,
          "assetIds": [
            "product",
            "imagestyle"
          ],
          "takes": [
            {
              "id": "v1",
              "label": "初版",
              "image": "assets/image-1.svg"
            }
          ]
        },
        {
          "id": "i2",
          "title": "暖光海报",
          "duration": 0,
          "scene": "深蓝底色中居中放置随行灯，用暖光建立视觉焦点。",
          "motion": "静态构图：中轴对称。",
          "dialogue": "让每一个夜晚，有光可依。",
          "image": "assets/image-2.svg",
          "status": "adopted",
          "version": 1,
          "assetIds": [
            "product",
            "imagestyle"
          ],
          "takes": [
            {
              "id": "v1",
              "label": "初版",
              "image": "assets/image-2.svg"
            }
          ]
        },
        {
          "id": "i3",
          "title": "产品详情",
          "duration": 0,
          "scene": "左侧产品大图，右侧排列三组简洁说明。",
          "motion": "静态构图：左右信息分区。",
          "dialogue": "柔和漫射 · 轻巧随行 · 简单如需",
          "image": "assets/image-3.svg",
          "status": "adopted",
          "version": 1,
          "assetIds": [
            "product",
            "imagestyle"
          ],
          "takes": [
            {
              "id": "v1",
              "label": "初版",
              "image": "assets/image-3.svg"
            }
          ]
        },
        {
          "id": "i4",
          "title": "社交方图",
          "duration": 0,
          "scene": "拱形米白背景、灯体居中，顶端保留品牌文字。",
          "motion": "静态构图：居中留白。",
          "dialogue": "LUMA",
          "image": "assets/image-4.svg",
          "status": "adopted",
          "version": 1,
          "assetIds": [
            "product",
            "imagestyle"
          ],
          "takes": [
            {
              "id": "v1",
              "label": "初版",
              "image": "assets/image-4.svg"
            }
          ]
        }
      ],
      "assets": [
        {
          "id": "product",
          "name": "LUMA 随行灯",
          "type": "产品",
          "version": 1,
          "locked": true,
          "image": "assets/promo-2.svg",
          "description": "沿用宣传片产品身份与已采用外观。"
        },
        {
          "id": "imagestyle",
          "name": "品牌套图规范",
          "type": "风格",
          "version": 1,
          "locked": true,
          "image": "assets/image-1.svg",
          "description": "冷蓝、米白、暖光三色；保持字体层级与留白。"
        },
        {
          "id": "brand",
          "name": "品牌文字",
          "type": "品牌",
          "version": 1,
          "locked": true,
          "image": "assets/promo-6.svg",
          "description": "LUMA 标识与主张；所有文案均为虚构示例。"
        }
      ]
    }
  ]
};
