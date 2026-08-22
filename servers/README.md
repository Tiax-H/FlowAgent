# servers/

自带 demo MCP Server：search（搜索）/ sandbox（代码沙箱）/ report（报告生成）。
同时用于验证 MCP Gateway 对生态第三方 Server 的兼容性。

## sandbox 的隔离边界（必读）

sandbox 是**限额执行**，不是安全沙箱：

- 已实现：限时（默认 5s，上限 15s）、代码长度 10KB、子进程堆内存上限 256MB、全局并发上限 2、输出截断 8KB、`shell:false` 子进程执行（绝不在本进程 eval）
- 未实现（demo 定位明确不做）：文件系统/网络隔离；超时击杀只覆盖直接子进程，用户代码派生的孙进程不在击杀范围

不要把 sandbox 暴露给不受信任的调用方（server 默认只监听 127.0.0.1）。
