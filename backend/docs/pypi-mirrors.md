# PyPI 镜像目录

核对日期：2026-10-06。内置 20 个 HTTPS 入口，包含官方、公共镜像、同站别名和转发入口；不是 20 个独立运营方，也不能保证覆盖互联网上所有镜像。可用性以实际部署服务器的测速结果为准。

| 入口 | 索引地址 | 说明 |
| --- | --- | --- |
| PyPI 官方 | https://pypi.org/simple/ | 文件通常位于 files.pythonhosted.org |
| 清华 TUNA | https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple/ | 教育网公共镜像 |
| 阿里云 | https://mirrors.aliyun.com/pypi/simple/ | 公共镜像 |
| 华为云 | https://repo.huaweicloud.com/repository/pypi/simple/ | 公共镜像 |
| 腾讯云 | https://mirrors.cloud.tencent.com/pypi/simple/ | 公网地址 |
| 中国科大 USTC | https://mirrors.ustc.edu.cn/pypi/simple/ | 可能将包文件转发至其他镜像 |
| 上海交大 SJTUG | https://mirror.sjtu.edu.cn/pypi/web/simple/ | 包文件可能转至交大 S3 存储 |
| 南京大学 | https://mirrors.nju.edu.cn/pypi/web/simple/ | 教育网公共镜像 |
| 浙江大学 | https://mirrors.zju.edu.cn/pypi/web/simple/ | 教育网公共镜像 |
| 南方科技大学 | https://mirrors.sustech.edu.cn/pypi/web/simple/ | 教育网公共镜像 |
| 北京外国语大学 | https://mirrors.bfsu.edu.cn/pypi/web/simple/ | 教育网公共镜像 |
| 河南省教科网 | https://mirrors.ha.edu.cn/pypi/simple/ | 支持 JSON 索引 |
| 南阳理工学院 | https://mirror.nyist.edu.cn/pypi/simple/ | 支持 JSON 索引 |
| 华中科技大学 | https://mirrors.hust.edu.cn/pypi/web/simple/ | 需检查目标版本同步情况 |
| 教育网自动路由 | https://mirrors.cernet.edu.cn/pypi/web/simple/ | 按网络转到具体镜像 |
| 百度 | https://mirror.baidu.com/pypi/simple/ | 候选入口，本机抽样返回 403 |
| 腾讯云备用入口 | https://mirrors.tencent.com/pypi/simple/ | 同运营方别名 |
| 清华备用入口 | https://pypi.tuna.tsinghua.edu.cn/simple/ | 同运营方别名 |
| 兰州大学转发入口 | https://mirror.lzu.edu.cn/pypi/web/simple/ | 转发入口，目标可能变化 |
| 豆瓣旧入口 | https://pypi.doubanio.com/simple/ | 旧转发入口，目标可能变化 |

来源包括 [CERNET PyPI 站点目录](https://mirrors.cernet.edu.cn/list/pypi)、[CERNET 使用说明](https://help.mirrors.cernet.edu.cn/pypi/)、[USTC 使用说明](https://mirrors.ustc.edu.cn/help/pypi.html)、[南科大说明](https://mirrors.sustech.edu.cn/help/pypi.html)、[MirrorZ 说明](https://help.mirrorz.org/pypi/)、[腾讯云软件源文档](https://intl.cloud.tencent.com/zh/document/product/213/8623)及各站公开同步元数据。别名和转发关系还通过实际 HTTPS 响应核对。

吉林大学目录显示长期暂停、南京工业大学同步状态陈旧，因此未加入自动选择。部分旧豆瓣 / 百度 BCEBOS 地址失效；仅云内网可访问的地址、私人源、ROCm / Jetson / PyTorch 等专项源不作为通用 musicdl 索引。

## 测速与安装

索引请求和 wheel 抽样各有 15 秒上限，最多同时检测 4 个入口，支持 HTML 和 PEP 691 JSON。索引最多 1 MiB，固定 musicdl 2.14.0 wheel 抽样最多 64 KiB，检查 ZIP 签名；重定向限制在已知 HTTPS 域名且最多五次。测速仅提供网络抽样，包安装的完整性由 uv / Python 包管理器负责。

网页逐项更新，不必等全部完成。失败显示索引阶段、文件下载阶段、HTTP 错误或超时。至少一个成功时缓存 30 分钟，全失败时缓存 1 分钟；「重新测速」绕过缓存。禁止用一次全失败结果长期阻止安装：下载抽样失败但索引可达的入口仍可以作为安装候选，最后尝试官方。

可用性以部署服务器的实时测速为准。同一镜像在不同网络下可能返回不同结果，索引可达也不代表目标 wheel 已同步。
