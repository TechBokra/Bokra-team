sed -i "s/userAgent: req.headers\['user-agent'\],/userAgent: req.headers['user-agent'] as string,/g" server.ts
