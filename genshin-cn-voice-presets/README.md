# Genshin Chinese Voice Preset Library

- Source dataset: https://huggingface.co/datasets/simon3000/genshin-voice
- Built at: 2026-05-19 19:20:55
- Max files per timbre folder: 20
- Rows scanned from dataset API: 15000
- Downloaded files: 204

## Folder Layout

- [女声] 01 萝莉 高音灵动 向导系: 12 files
  Description: 亮度高，齿音明显，适合小精灵、向导、活泼吉祥物。
  Speaker pool: Paimon, Klee
- [女声] 02 幼态软萌 轻气治愈: 15 files
  Description: 奶气、轻气声、柔软，适合陪伴感和童声治愈路线。
  Speaker pool: Nahida, Qiqi, Yaoyao, Sayu, Diona
- [女声] 03 少女 明亮元气 生活感: 15 files
  Description: 开口清脆，节奏轻快，适合日常向、元气向年轻女声。
  Speaker pool: Xiangling, Amber, Yoimiya, Collei, Barbara
- [女声] 04 少女 俏皮灵巧 跳脱感: 15 files
  Description: 俏皮、跳脱、带机灵感，适合古灵精怪和情绪起伏大的角色。
  Speaker pool: Furina, Hu Tao, Fischl, Yanfei
- [女声] 05 少女 清冷通透 收束感: 15 files
  Description: 字头干净，尾音克制，适合清冷理性、透明感路线。
  Speaker pool: Keqing, Lynette, Layla, Ganyu
- [女声] 06 成女 端庄优雅 名门感: 15 files
  Description: 优雅、稳定、贵气明显，适合大小姐、名门、得体叙述。
  Speaker pool: Kamisato Ayaka, Ningguang, Navia, Jean, Barbara, Nilou
- [女声] 07 成女 冷冽威压 低温感: 15 files
  Description: 低温、锋利、压迫感强，适合御姐、上位者、肃杀路线。
  Speaker pool: Raiden Shogun, Shenhe, Rosaria, Clorinde
- [女声] 08 成女 妩媚知性 慵懒磁性: 15 files
  Description: 胸声更重，语速从容，适合知性、妩媚、慵懒女声。
  Speaker pool: Lisa, Yae Miko, Yelan, Beidou
- [男声] 01 少年 清亮元气 自然对白: 15 files
  Description: 音色亮、颗粒轻，适合阳光少年、清爽陪伴和生活化对白。
  Speaker pool: Bennett, Chongyun, Mika, Gaming
- [男声] 02 少年 温柔书卷 轻柔叙述: 15 files
  Description: 气息柔和，文气明显，适合书卷、吟游、温柔少年路线。
  Speaker pool: Xingqiu, Venti, Kaedehara Kazuha, Kazuha, Lyney, Albedo
- [男声] 03 少年 锋利冷感 收声明显: 15 files
  Description: 冷感、锐利、情绪内收，适合寡言、锋利、疏离感男声。
  Speaker pool: Xiao, Wanderer, Cyno, Heizou, Shikanoin Heizou, Alhaitham
- [男声] 04 青年 温润知性 理性稳定: 12 files
  Description: 发声稳定，气息平顺，适合理性、医生、学者、知性男声。
  Speaker pool: Tighnari, Baizhu, Ayato
- [男声] 05 青年 沉稳磁性 权威感: 15 files
  Description: 中低频更重，成熟稳健，适合领导者、旁白、权威感男声。
  Speaker pool: Zhongli, Neuvillette, Diluc
- [男声] 06 青年 痞帅张力 攻击性: 15 files
  Description: 外放、挑衅、张力强，适合反派感、战斗感、痞帅男声。
  Speaker pool: Childe, Tartaglia, Arataki Itto, Razor, Wriothesley, Kaeya

## Notes

- Only rows marked as `Chinese` were used.
- Empty lines and pure animator event rows were skipped.
- Each folder was capped at 20 files, and each individual speaker was capped to improve diversity.
- See `manifest.json` for per-file metadata.
