// Privileged (host-side) handlers for キャラチャット.
//
// resolveHostAddresses: 取り込み時の画像取得（server/src/actions.ts の
// fetchImageBytes）が、取得先ホスト名の名前解決を内部アドレス遮断の判定に
// 使うための口。アクションのワーカーからは Node/Bun のホストモジュール
// （node:dns）を import できないため、名前解決だけをここへ置く。判定そのもの
// （解決先アドレスがプライベート／ループバック／リンクローカル／予約済みか）
// は actions.ts 側で行う。解決に失敗・超過した場合は ok=false を返し、
// 呼び出し側は取得しない側へ倒す（fail closed）。

import { definePrivilegedContracts, definePrivilegedHandlers, z } from "@hatch/space-sdk";
import { lookup } from "node:dns/promises";

export const privileged = definePrivilegedContracts({
  resolveHostAddresses: {
    request: z.object({
      // 解決するホスト名（IP リテラルは呼び出し側で判定済みのため渡ってこない）。
      hostname: z.string().min(1).max(253),
    }),
    response: z.object({
      // 解決できたかどうか。false は失敗・タイムアウト（アドレスは空）。
      ok: z.boolean(),
      // 解決先アドレス（IPv4 / IPv6 の文字列）の一覧。
      addresses: z.array(z.string().max(64)).max(64),
    }),
  },
});

const DNS_LOOKUP_TIMEOUT_MS = 10_000;

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  async resolveHostAddresses(args) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const addresses = await Promise.race([
        lookup(args.hostname, { all: true, verbatim: true }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("dns lookup timeout")), DNS_LOOKUP_TIMEOUT_MS);
        }),
      ]);
      return { ok: true, addresses: addresses.map((a) => a.address) };
    } catch {
      return { ok: false, addresses: [] };
    } finally {
      if (timer) clearTimeout(timer);
    }
  },
});
