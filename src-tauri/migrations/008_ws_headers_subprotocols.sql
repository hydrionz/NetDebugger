-- 008: WS 客户端自定义请求头（JSON 对象）和子协议（JSON 数组）
-- headers: {"Header-Name":"value",...}  TEXT，NULL 表示无
-- subprotocols: ["proto1","proto2",...]  TEXT，NULL 表示无
ALTER TABLE sessions ADD COLUMN headers TEXT;
ALTER TABLE sessions ADD COLUMN subprotocols TEXT;
