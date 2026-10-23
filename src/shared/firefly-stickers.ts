/** 手动选择的内置表情包（聊天输入框表情面板、表情包管理）；不参与自动发送。 */
export const FIREFLY_MANUAL_STICKERS = [
  {"id": "firefly-hug", "file": "hug.png", "sourceFile": "抱抱.png", "description": "张开双臂，抱抱", "phrases": ["张开双臂，抱抱", "想给你一个拥抱"]},
  {"id": "firefly-meal", "file": "meal.png", "sourceFile": "吃饭.png", "description": "端着饭碗，吃饭", "phrases": ["端着饭碗，吃饭", "到吃饭时间啦"]},
  {"id": "firefly-cry", "file": "cry.png", "sourceFile": "大哭.png", "description": "流着眼泪，大哭", "phrases": ["流着眼泪，大哭", "难过得哭了"]},
  {"id": "firefly-thumbs-up", "file": "thumbs-up.png", "sourceFile": "点赞.png", "description": "竖起拇指，点赞", "phrases": ["竖起拇指，点赞", "做得真好"]},
  {"id": "firefly-holiday", "file": "holiday.png", "sourceFile": "放假.png", "description": "躺着休息，放假", "phrases": ["躺着休息，放假", "放假好好休息吧"]},
  {"id": "firefly-shy", "file": "shy.png", "sourceFile": "害羞.png", "description": "捂着嘴，害羞", "phrases": ["捂着嘴，害羞", "有一点不好意思"]},
  {"id": "firefly-tea", "file": "tea.png", "sourceFile": "喝茶.png", "description": "捧着茶杯，喝茶", "phrases": ["捧着茶杯，喝茶", "一起歇一会儿吧"]},
  {"id": "firefly-cheer", "file": "cheer.png", "sourceFile": "加油.png", "description": "握拳鼓励，加油", "phrases": ["握拳鼓励，加油", "我为你加油"]},
  {"id": "firefly-happy", "file": "happy.png", "sourceFile": "开心.png", "description": "双手捧脸，开心", "phrases": ["双手捧脸，开心", "现在心情很好"]},
  {"id": "firefly-sleepy", "file": "sleepy.png", "sourceFile": "困了.png", "description": "揉眼睛，困了", "phrases": ["揉眼睛，困了", "有点想睡觉了"]},
  {"id": "firefly-tired", "file": "tired.png", "sourceFile": "累了.png", "description": "趴着休息，累了", "phrases": ["趴着休息，累了", "先休息一下吧"]},
  {"id": "firefly-hello", "file": "hello.png", "sourceFile": "你好.png", "description": "张开手打招呼，你好", "phrases": ["张开手打招呼，你好", "你好呀"]},
  {"id": "firefly-kiss", "file": "kiss.png", "sourceFile": "亲亲.png", "description": "闭眼送吻，亲亲", "phrases": ["闭眼送吻，亲亲", "送你一个亲亲"]},
  {"id": "firefly-angry", "file": "angry.png", "sourceFile": "生气.png", "description": "鼓起脸，生气", "phrases": ["鼓起脸，生气", "有点生气了"]},
  {"id": "firefly-received", "file": "received.png", "sourceFile": "收到.png", "description": "抬手回应，收到", "phrases": ["抬手回应，收到", "明白啦"]},
  {"id": "firefly-good-night", "file": "good-night.png", "sourceFile": "晚安.png", "description": "抱着枕头，晚安", "phrases": ["抱着枕头，晚安", "愿你睡个好觉"]},
  {"id": "firefly-upset", "file": "upset.png", "sourceFile": "委屈.png", "description": "眼含泪水，委屈", "phrases": ["眼含泪水，委屈", "觉得有点委屈"]},
  {"id": "firefly-miss-me", "file": "miss-me.png", "sourceFile": "想我没.png", "description": "指着脸询问，想我没", "phrases": ["指着脸询问，想我没", "有没有想我呀"]},
  {"id": "firefly-thanks", "file": "thanks.png", "sourceFile": "谢谢.png", "description": "抱着花束，谢谢", "phrases": ["抱着花束，谢谢", "谢谢你呀"]},
  {"id": "firefly-good-morning", "file": "good-morning.png", "sourceFile": "早安.png", "description": "挥手问候，早安", "phrases": ["挥手问候，早安", "早上好"]},
  {"id": "firefly-okay", "file": "okay.png", "sourceFile": "OK.png", "description": "做出OK手势", "phrases": ["做出OK手势", "好呀，没问题"]},
] as const;

/** 流萤在对话中会按语义自动发送的表情包；自动匹配只使用这一组（以及用户自己加的贴图）。 */
export const FIREFLY_AUTO_STICKERS = [
  {"id": "firefly-pout", "mood": "negative", "file": "pout.png", "sourceFile": "pout.png", "description": "鼓着脸，指着你生气", "phrases": ["鼓着脸，指着你生气", "哼，我有点不高兴了"]},
  {"id": "firefly-wink", "mood": "positive", "file": "wink.png", "sourceFile": "wink.png", "description": "手指点着眼角，俏皮眨眼", "phrases": ["手指点着眼角，俏皮眨眼", "悄悄地向你眨眨眼"]},
  {"id": "firefly-amazed", "mood": "positive", "file": "amazed.png", "sourceFile": "amazed.png", "description": "星星眼，惊讶地张着嘴", "phrases": ["星星眼，惊讶地张着嘴", "哇，好厉害"]},
  {"id": "firefly-smile-ok", "mood": "positive", "file": "smile-ok.png", "sourceFile": "smile-ok.png", "description": "微笑着比出OK手势", "phrases": ["微笑着比出OK手势", "放心，交给我吧"]},
  {"id": "firefly-flustered", "mood": "positive", "file": "flustered.png", "sourceFile": "flustered.png", "description": "双手捧脸，脸红慌张", "phrases": ["双手捧脸，脸红慌张", "被夸得有点不好意思"]},
  {"id": "firefly-bubble-tea", "mood": "positive", "file": "bubble-tea.png", "sourceFile": "bubble-tea.png", "description": "捧着珍珠奶茶，吸着吸管", "phrases": ["捧着珍珠奶茶，吸着吸管", "来杯奶茶放松一下"]},
  {"id": "firefly-wink-tongue", "mood": "positive", "file": "wink-tongue.png", "sourceFile": "wink-tongue.png", "description": "眨眼吐舌，比着剪刀手", "phrases": ["眨眼吐舌，比着剪刀手", "嘿嘿，得意地比个耶"]},
  {"id": "firefly-cake", "mood": "positive", "file": "cake.png", "sourceFile": "cake.png", "description": "端着草莓蛋糕，吃得满足", "phrases": ["端着草莓蛋糕，吃得满足", "吃甜点的时间到啦"]},
] as const;

/** 全部内置表情包（渲染、渠道发送、管理窗口按 ID 查找用）。 */
export const FIREFLY_STICKERS = [...FIREFLY_MANUAL_STICKERS, ...FIREFLY_AUTO_STICKERS] as const;
