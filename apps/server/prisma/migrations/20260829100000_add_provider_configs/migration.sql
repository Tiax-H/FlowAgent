-- Provider 网页端配置（加密存储）：apiKey 以 AES-256-GCM 密文落库，主密钥来自 FLOWAGENT_SECRET_KEY。
-- 与环境变量配置互斥：name 与 env 解析结果（小写化）不可同名，由服务层校验。
-- CreateTable
CREATE TABLE "provider_configs" (
    "name" TEXT NOT NULL PRIMARY KEY,
    "baseURL" TEXT NOT NULL,
    "apiKeyEncrypted" TEXT NOT NULL,
    "models" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
