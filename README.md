# 弈境 · 五子棋联机平台

一个无需注册、开箱即用的双人在线五子棋平台。创建房间后，把同一个邀请链接发给朋友，两人都点击「开始游戏」即可自动开局。

## 功能

- 专属邀请链接与 6 位房间号
- 服务端权威判定落子、轮次、五子连珠与和棋
- SSE 实时同步，断线后自动重连
- 双方准备后自动开局，再来一局自动交换黑白
- 15 × 15 标准棋盘，实时棋谱与对局计时
- 房间聊天、快捷表情、第三人观战
- 手机、平板、桌面端自适应
- 零第三方运行依赖，仅需 Node.js 18+

## 本地运行

```bash
node server.js
```

打开 `http://localhost:3000`。同一局域网内的设备可使用启动日志中显示的“局域网访问”地址。

如果使用 npm：

```bash
npm start
```

## 玩法

1. 第一位玩家输入称呼并创建棋局。
2. 点击「复制邀请链接」，将链接发给朋友。
3. 朋友打开链接、输入称呼并加入。
4. 两位棋手分别点击「开始游戏」。
5. 双方准备完成后自动开局，黑棋先行。

刷新页面会通过浏览器本地令牌自动回到原座位；关闭页面不会立即判负，可稍后回来继续。

## 部署

### Docker

```bash
docker build -t yijing-gomoku .
docker run -p 3000:3000 yijing-gomoku
```

### Render / Railway / Fly.io

- 启动命令：`node server.js`
- 端口：读取环境变量 `PORT`
- 无需安装任何 npm 依赖
- 健康检查：`GET /health`

项目包含 `render.yaml`，可直接用于 Render Blueprint 部署。

## 项目结构

```text
server.js           Node.js HTTP、房间状态、SSE、规则判定
public/index.html   页面结构
public/styles.css   响应式视觉效果
public/app.js       棋盘渲染、实时交互和房间操作
Dockerfile          容器部署配置
```

## 说明

当前房间数据保存在进程内存中，适合个人对弈与单实例部署。服务重启后房间会清空；如需多实例部署或长期保存棋谱，应将房间状态迁移到 Redis/数据库，并使用 Redis Pub/Sub 广播状态。
## 固定公网地址

静态联机版托管在 GitHub Pages：

https://kaydenchen10.github.io/yijing-gomoku/

该版本使用 WebRTC 点对点联机，不需要运行本机 Node.js 服务。房主页面需要保持打开；房主关闭页面后，其他玩家无法继续同步，重新打开同一房间链接可恢复房主保存的房间。

页面通过 PeerJS 公共信令服务建立 WebRTC 连接，游戏落子、棋局状态和聊天数据点对点传输。