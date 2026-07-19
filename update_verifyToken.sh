sed -i 's/if (error || !user) {/if (error || !user) { console.error("verifyToken auth.getUser error:", error, "user:", user);/g' server.ts
