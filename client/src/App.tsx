import { Fragment, useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim, setFailureNoticeText } from "@hatch/space-sdk/client";
import { actionFields } from "@hatch/space-sdk/fields" with { type: "macro" };
import type { Actions } from "../../server/src/actions";
import {
  categoryAncestorIds,
  categoryDescendantIds,
  pruneAncestorCategoryIds as pruneAncestorCategoryIdsShared,
  type CategoryTreeNode,
} from "../../server/src/category-tree";
import { api, type ApiResponse } from "./api";
import { TEXTS as T } from "./display-texts";

setFailureNoticeText((error) => {
  const e = error as { issues?: unknown; message?: string } | null;
  if (e && Array.isArray(e.issues)) return T.notice.inputCheck;
  if (e?.message) return e.message;
  return T.notice.genericFailure;
});

const FIELDS = actionFields<typeof Actions>();

type Home = ApiResponse<typeof api, "listHome">;
type CharacterItem = Home["characters"][number];
type GroupItem = Home["groups"][number];
type ChatState = ApiResponse<typeof api, "getChatState">;
type GroupState = ApiResponse<typeof api, "getGroupState">;
type RequestInfo = ChatState["request"];

type View =
  | { kind: "home" }
  // unreadFromSeq: 開く直時点での未読の先頭キャラ発言の seq（設計書 v1.8 / 4.9章）。
  // 一覧（listHome）が計算した値を遷移時に固定して渡し、開いている間に
  // 到着した返信では区切り位置が動かないようにする。未読が無ければ null。
  | { kind: "chat"; characterId: number; unreadFromSeq: number | null }
  | { kind: "group"; groupId: number; unreadFromSeq: number | null }
  // 全体ログ（履歴ページ、設計書 v2.0 / D）。入口はホーム下部の目立たないリンク。
  | { kind: "logs" };

type SchedulesData = ApiResponse<typeof api, "listSchedules">;
type ScheduleItem = SchedulesData["schedules"][number];
type AppLogsData = ApiResponse<typeof api, "listAppLogs">;
type AppLogItem = AppLogsData["logs"][number];

const FAIL_REASONS: Record<string, string> = {
  timeout: T.failReasons.timeout,
  rate_limited: T.failReasons.rateLimited,
  auth_error: T.failReasons.authError,
  generation_error: T.failReasons.generationError,
  pending_timeout: T.failReasons.pendingTimeout,
};

/** 失敗理由コード→表示文の共通解決（理由マップ→詳細つき文→フォールバック）。 */
function labelFrom(
  map: Record<string, string>,
  reason: string,
  withDetail: (reason: string) => string,
  fallback: string,
): string {
  return map[reason] ?? (reason ? withDetail(reason) : fallback);
}

function failReasonLabel(reason: string): string {
  return labelFrom(FAIL_REASONS, reason, T.failReasons.withDetail, T.failReasons.fallback);
}

/** エラーから表示用メッセージを取り出す（Error でなければ fallback を使う）。 */
function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

// ひらがなとカタカナを区別しない検索用に、ひらがなをカタカナへ寄せて
// 小文字化した文字列を返す。検索語とキャラ名の両方に適用して照合すると、
// ひらがなの検索語でもカタカナの名前が一致し、その逆も一致する。
function normalizeKanaForSearch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));
}

// スマホ（タッチ主体の端末）かどうか。PC では Enter で送信するが、スマホでは
// Enter は改行にし、送信は送信ボタンで行う（利用者の要望）。判定は
// pointer: coarse（主ポインタがタッチ）で行い、タッチ対応 PC でもマウス・
// キーボード主体なら Enter 送信のままになる。
function isTouchPrimary(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
}

function formatElapsed(totalSeconds: number): string {
  if (totalSeconds < 60) return T.elapsed.seconds(totalSeconds);
  const m = Math.floor(totalSeconds / 60);
  if (m < 60) return T.elapsed.minutes(m);
  return T.elapsed.hoursMinutes(Math.floor(m / 60), m % 60);
}

/** 現在時刻を一定間隔で更新する（経過時間の表示用）。enabled の間だけ回す。 */
function useNow(enabled: boolean, intervalMs = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [enabled, intervalMs]);
  return now;
}

/** ISO日時から現在時刻までの経過秒（負にはならない）。 */
function elapsedSecondsSince(iso: string | null | undefined, now: number): number {
  if (!iso) return 0;
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
}

/**
 * 一括取り込みの状態まわり（一覧と取り込みシートで共用）: キック、状態の
 * ポーリング、running→done/failed 遷移時の一覧再取得、取り込み中の
 * 経過表示用の現在時刻。
 */
function useImportStatus() {
  const queryClient = useQueryClient();
  const importKick = useMutation({
    mutationFn: async () => await api.requestImport({}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["home"] });
      queryClient.invalidateQueries({ queryKey: ["import-status"] });
    },
  });
  // 一括取り込みのステータス（ローカル改善4の復元）: 状態をポーリングし、
  // 取り込み中はバナーを出し、完了・失敗したら一覧を再取得して結果バナーを出す。
  const importStatus = useQuery({
    queryKey: ["import-status"],
    queryFn: () => api.getImportStatus({}),
    refetchInterval: (q) => (q.state.data?.state === "running" ? 5000 : 15000),
  });
  const prevImportStateRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const st = importStatus.data?.state;
    if (!st) return;
    const prev = prevImportStateRef.current;
    prevImportStateRef.current = st;
    if ((st === "done" || st === "failed") && prev === "running") {
      queryClient.invalidateQueries({ queryKey: ["home"] });
    }
  }, [importStatus.data?.state, queryClient]);
  // 取り込み中の経過時間表示用に現在時刻を定期更新する。
  const now = useNow(importStatus.data?.state === "running");
  return { importKick, importStatus, now };
}

// チャット画面のレイアウト固定（v1.16 で整理）: 対策は次の2つだけに絞る。
// (1) チャット画面表示中は body のスクロールを止める（このフック）。
//     あわせて theme.css の overscroll-behavior: none で引っ張り更新を消す。
// (2) 画面の箱は 100dvh の固定配置 flex 列とし、入力欄は最下段に置く。
// キーボード表示時の追従は JS では一切補正せず、index.html の viewport
// メタ（interactive-widget=resizes-content）でブラウザ自身がレイアウト
// ビューポートを縮めるのに任せる。100dvh がそのまま縮むので、入力欄は
// キーボードの真上に来る。
// v1.13〜v1.15 では visualViewport 追従シェル／計算式インセット／実測
// フィードバック補正を重ねたが、ブラウザ側の縮小と二重に効いて入力欄の
// 下に空白が残り続けたため、補正系は全て撤去し仕組みをこの1本に統一した。
function useLockBodyScroll() {
  useEffect(() => {
    const body = document.body;
    const prevOverflow = body.style.overflow;
    const prevOverscroll = body.style.overscrollBehavior;
    body.style.overflow = "hidden";
    body.style.overscrollBehavior = "none";
    return () => {
      body.style.overflow = prevOverflow;
      body.style.overscrollBehavior = prevOverscroll;
    };
  }, []);
}

function Avatar({
  imageUrl,
  name,
  themeColor,
  size,
}: {
  imageUrl: string | null;
  name: string;
  themeColor: string;
  size: number;
}) {
  const ring = themeColor || "var(--accent)";
  const [imgError, setImgError] = useState(false);
  if (imageUrl && !imgError) {
    return (
      <img
        src={imageUrl}
        alt={name}
        width={size}
        height={size}
        onError={() => setImgError(true)}
        className="shrink-0 rounded-full object-cover"
        style={{ width: size, height: size, boxShadow: `0 0 0 2px var(--surface), 0 0 0 4px ${ring}` }}
      />
    );
  }
  return (
    <div
      aria-label={name}
      className="font-display flex shrink-0 items-center justify-center rounded-full font-bold"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        color: "var(--surface)",
        background: ring,
        boxShadow: `0 0 0 2px var(--surface), 0 0 0 4px ${ring}`,
      }}
    >
      {name.slice(0, 1)}
    </div>
  );
}

function StatusBadge({ status, reviewing }: { status: string; reviewing?: boolean }) {
  // 自動レビュー実行中は「返信待ち」の代わりに「レビュー中」（青色）を示す。
  // レビューが終わって返信生成へ移ると reviewing が false になり、従来の
  // 表示へ戻る。返信生成が行われない単独レビュー（status="none"）でも出す。
  if (reviewing && status !== "processing" && status !== "failed")
    return <span className="rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: "var(--info-soft)", color: "var(--info)" }}>{T.status.reviewing}</span>;
  if (status === "pending")
    return <span className="rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: "var(--accent-soft)", color: "var(--gold)" }}>{T.status.pending}</span>;
  if (status === "processing")
    return <span className="rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>{T.status.processing}</span>;
  if (status === "failed")
    return <span className="rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: "var(--accent-soft)", color: "var(--danger)" }}>{T.status.failed}</span>;
  return null;
}

function RequestBanner({ request, isGroup }: { request: RequestInfo; isGroup?: boolean }) {
  const now = useNow(request.status === "pending" || request.status === "processing" || request.reviewing);
  if (request.status === "none") {
    // 進行中のリクエストが無くても、自動レビューだけが実行中（返信生成が
    // 行われないなりきり投稿の単独レビュー）の間は「レビュー中」を出す。
    if (!request.reviewing) return null;
    const elapsed = request.requested_at
      ? elapsedSecondsSince(request.requested_at, now)
      : request.elapsed_seconds;
    return (
      <div className="mx-3 mt-2 rounded-xl px-3 py-2 text-sm" style={{ background: "var(--accent-soft)", color: "var(--text)" }} role="status">
        {T.requestBanner.reviewing(formatElapsed(elapsed))}
      </div>
    );
  }
  if (request.status === "failed") {
    return (
      <div className="mx-3 mt-2 rounded-xl px-3 py-2 text-sm" style={{ background: "var(--accent-soft)", color: "var(--danger)" }} role="status">
        <p>{failReasonLabel(request.fail_reason)}{T.requestBanner.failedSuffix}</p>
        {request.fail_detail ? (
          <p className="mt-1 text-xs whitespace-pre-wrap break-words" style={{ color: "var(--dim)" }}>詳細: {request.fail_detail}</p>
        ) : null}
      </div>
    );
  }
  const elapsed = request.requested_at
    ? elapsedSecondsSince(request.requested_at, now)
    : request.elapsed_seconds;
  return (
    <div className="mx-3 mt-2 rounded-xl px-3 py-2 text-sm" style={{ background: "var(--accent-soft)", color: "var(--text)" }} role="status">
      {request.status === "processing"
        ? T.requestBanner.generating(isGroup ? T.requestBanner.groupWord : T.requestBanner.replyWord, formatElapsed(elapsed))
        : request.reviewing
          ? T.requestBanner.reviewing(formatElapsed(elapsed))
          : T.requestBanner.waiting(isGroup ? T.requestBanner.groupWord : T.requestBanner.replyWord, formatElapsed(elapsed))}
    </div>
  );
}

/** 「自動」の議題の投稿カード（ローカル改善）。利用者の発言ともキャラの発言とも
 *  区別できるよう、中央に「自動」と分かる形で表示する。 */
function TopicCard({ body, source }: { body: string; source: string }) {
  const label = T.autoTopic.sourceLabels[source];
  return (
    <div
      className="w-full max-w-[92%] rounded-2xl px-4 py-3"
      style={{ background: "var(--accent-soft)", border: "1.5px dashed var(--gold)" }}
    >
      <p className="text-xs font-black" style={{ color: "var(--gold)" }}>
        {T.autoTopic.cardHeading(label)}
      </p>
      <p className="mt-1 text-base whitespace-pre-wrap" style={{ color: "var(--text)" }}>{body}</p>
    </div>
  );
}

/** 送信取り消しボタン（返信待ちの間だけ、対象の利用者発言の下に出る）。
 *  1対1／グループの各発言分岐で同じ見た目・文言を使うため部品化する。 */
function CancelSendButton({
  onCancel,
  pending,
  selfStart,
}: {
  onCancel: () => void;
  pending: boolean;
  selfStart?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onCancel}
      disabled={pending}
      aria-label={T.chat.cancelSendAria}
      className={
        selfStart
          ? "mt-1 self-start rounded-full px-3 py-1 text-xs font-bold disabled:opacity-50"
          : "mt-1 rounded-full px-3 py-1 text-xs font-bold disabled:opacity-50"
      }
      style={{ background: "var(--surface)", color: "var(--danger)", border: "1px solid var(--border)" }}
    >
      {T.chat.cancelSend}
    </button>
  );
}

/** ゲスト・モブ・ナレーションの許可チェック3点セット（スケジュール作成・
 * グループ作成・グループ設定で共用）。variant は行の見た目:
 * "simple" はラベルだけの行、"described" は説明つきの行。 */
type GuestMobFlags = { guests: boolean; mobs: boolean; narration: boolean };

function GuestMobToggles({
  value,
  onChange,
  labels,
  variant,
  containerClassName,
}: {
  value: GuestMobFlags;
  onChange: (next: GuestMobFlags) => void;
  labels: {
    guests: string;
    mobs: string;
    narration: string;
    guestsDesc?: string;
    mobsDesc?: string;
    narrationDesc?: string;
  };
  variant: "simple" | "described";
  containerClassName: string;
}) {
  const rows = [
    { key: "guests" as const, checked: value.guests, aria: T.guestMob.allowGuestsAria, label: labels.guests, desc: labels.guestsDesc },
    { key: "mobs" as const, checked: value.mobs, aria: T.guestMob.allowMobsAria, label: labels.mobs, desc: labels.mobsDesc },
    { key: "narration" as const, checked: value.narration, aria: T.guestMob.allowNarrationAria, label: labels.narration, desc: labels.narrationDesc },
  ];
  return (
    <div className={containerClassName}>
      {rows.map((r) =>
        variant === "described" ? (
          <label key={r.key} className="flex cursor-pointer items-start gap-3 rounded-2xl px-3 py-3" style={{ background: r.checked ? "var(--accent-soft)" : "var(--surface-alt)" }}>
            <input
              type="checkbox"
              checked={r.checked}
              onChange={(e) => onChange({ ...value, [r.key]: e.target.checked })}
              aria-label={r.aria}
              className="mt-0.5 h-5 w-5 shrink-0"
            />
            <span>
              <span className="block font-bold" style={{ color: "var(--text)" }}>{r.label}</span>
              <span className="mt-0.5 block text-xs leading-relaxed" style={{ color: "var(--dim)" }}>
                {r.desc}
              </span>
            </span>
          </label>
        ) : (
          <label key={r.key} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-2xl px-2 py-1.5" style={{ background: r.checked ? "var(--accent-soft)" : "transparent" }}>
            <input
              type="checkbox"
              checked={r.checked}
              onChange={(e) => onChange({ ...value, [r.key]: e.target.checked })}
              aria-label={r.aria}
              className="h-5 w-5 shrink-0"
            />
            <span className="font-bold" style={{ color: "var(--text)" }}>{r.label}</span>
          </label>
        ),
      )}
    </div>
  );
}

/** 「自動」の設定シート（ローカル改善）。各チャットの設定メニューから開く。
 *  オンにすると、会話が一区切りして入力待ちのまま30分動きが無い時に、
 *  議題が1つ自動で投稿されてキャラが反応する。 */
function AutoTopicSheet({
  targetKind,
  targetId,
  targetName,
  currentEnabled,
  onClose,
}: {
  targetKind: "chat" | "group";
  targetId: number;
  targetName: string;
  currentEnabled: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(currentEnabled);
  const [error, setError] = useState("");
  const save = useMutation({
    mutationFn: async () => await api.setAutoTopic({ target_kind: targetKind, target_id: targetId, enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["home"] });
      queryClient.invalidateQueries({ queryKey: [targetKind === "chat" ? "chat" : "group", targetId] });
      onClose();
    },
    onError: (e) => setError(errMsg(e, T.common.saveFailed)),
  });
  return (
    <div className="sheet-overlay fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(10,6,20,0.55)" }} role="dialog" aria-modal="true" aria-label={T.autoTopic.sheetAria}>
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded-3xl p-5" style={{ background: "var(--surface)" }}>
        <h2 className="font-display text-lg font-bold" style={{ color: "var(--text)" }}>{T.autoTopic.sheetTitle}</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>{targetName}</p>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--dim)" }}>
          {T.autoTopic.sheetIntro(T.autoTopic.hint)}
        </p>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--dim)" }}>
          {T.autoTopic.sheetAutoPostDesc}
        </p>
        <div className="mt-4 flex flex-col gap-2">
          <label className="flex cursor-pointer items-start gap-3 rounded-2xl px-3 py-3" style={{ background: enabled ? "var(--accent-soft)" : "var(--surface-alt)" }}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              aria-label={T.autoTopic.autoPostToggleAria}
              className="mt-0.5 h-5 w-5 shrink-0"
            />
            <span>
              <span className="block font-bold" style={{ color: "var(--text)" }}>{T.autoTopic.autoPostLabel}</span>
              <span className="mt-0.5 block text-xs leading-relaxed" style={{ color: "var(--dim)" }}>
                {T.autoTopic.autoPostDesc}
              </span>
            </span>
          </label>
        </div>
        {error && <p className="mt-2 text-sm" style={{ color: "var(--danger)" }}>{error}</p>}
        <div className="mt-4 flex gap-3">
          <button type="button" onClick={onClose} className="flex-1 rounded-full px-4 py-2.5 font-bold" style={{ background: "var(--surface-alt)", color: "var(--text)" }}>
            {T.common.cancel}
          </button>
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="flex-1 rounded-full px-4 py-2.5 font-bold text-white disabled:opacity-50"
            style={{ background: "var(--accent)" }}
          >
            {save.isPending ? T.common.saving : T.common.save}
          </button>
        </div>
      </div>
    </div>
  );
}

/** チャット画面内の「新着」区切り（LINE風、設計書 v1.8 / 4.9章）。未読の先頭発言の直前に置く。 */
function NewMessageDivider() {
  return (
    <div className="flex items-center gap-3 py-1" role="separator" aria-label={T.divider.newMessagesAria}>
      <span aria-hidden="true" className="h-0.5 flex-1 rounded-full" style={{ background: "var(--danger)" }} />
      <span className="text-xs font-black tracking-widest" style={{ color: "var(--danger)" }}>{T.divider.newMessages}</span>
      <span aria-hidden="true" className="h-0.5 flex-1 rounded-full" style={{ background: "var(--danger)" }} />
    </div>
  );
}

/** 区間の帯: 区間と区間の間に置く、その区間で最初に生成された掛け合いの
 * 生成日時（JST、日付＋時分）を載せる帯。帯の地は区間フレームより更に暗い色
 * （--segment-band）で、上下のフレームの角丸の裏側まで回り込む（負マージンで
 * フレームの下へ潜らせる）。フレームはこの帯の所でのみ角丸で「閉じて」見え、
 * それ以外の場所では横幅いっぱいに通常の背景と連続する。 */
function SegmentBand({ date }: { date: string | null }) {
  return (
    <div
      className="relative z-0 -my-6 flex items-center justify-center py-9"
      style={{ background: "var(--segment-band)" }}
      role="separator"
      aria-label={T.segment.bandAria(date)}
    >
      {date && (
        <span className="text-xs font-bold tracking-wider" style={{ color: "var(--text)" }}>
          {date}
        </span>
      )}
    </div>
  );
}

/** ISO日時を JST の "YYYY/MM/DD HH:MM" に整形する（区間の帯の日時用）。 */
function formatSegmentDateTime(iso: string): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}/${get("month")}/${get("day")} ${get("hour")}:${get("minute")}`;
}

type SegmentGroup<M> = { segmentNo: number; date: string | null; messages: M[] };

/** 発言列を区間（segment_no の連続した並び）ごとにまとめる（設計書 v3.3）。
 * 帯に載せる日時 date は、その区間の segment_date（サーバが付けた、その区間で
 * 最初に履歴なし生成された掛け合いの生成日時）を優先し、区間に履歴なし生成が
 * 無い場合は区間先頭の発言の作成日時（JST）を使う。 */
function groupIntoSegments<M extends { segment_no: number; segment_date: string | null; created_at: string }>(
  messages: M[],
): SegmentGroup<M>[] {
  const groups: SegmentGroup<M>[] = [];
  for (const m of messages) {
    const last = groups[groups.length - 1];
    if (last && last.segmentNo === m.segment_no) {
      last.messages.push(m);
    } else {
      groups.push({ segmentNo: m.segment_no, date: null, messages: [m] });
    }
  }
  for (const g of groups) {
    const first = g.messages[0];
    g.date = g.messages.find((m) => m.segment_date)?.segment_date ?? (first ? formatSegmentDateTime(first.created_at) : null);
  }
  return groups;
}

/** チャット全文出力シート（設計書 v1.8 / 4.12章）。全履歴をプレーンテキストで表示し、全文コピーできる。 */
function ExportSheet({
  title,
  queryKey,
  fetchText,
  onClose,
}: {
  title: string;
  queryKey: string[];
  fetchText: () => Promise<{ text: string }>;
  onClose: () => void;
}) {
  const q = useQuery({ queryKey, queryFn: fetchText });
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const copyAll = async () => {
    if (!q.data) return;
    try {
      await navigator.clipboard.writeText(q.data.text);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  };
  return (
    <div className="sheet-overlay fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(10,6,20,0.55)" }} role="dialog" aria-modal="true" aria-label={title}>
      <div className="flex max-h-full w-full max-w-md flex-col rounded-3xl p-5" style={{ background: "var(--surface)" }}>
        <div className="flex items-start justify-between gap-3">
          <h2 className="font-display text-lg font-bold" style={{ color: "var(--text)" }}>{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={T.exportSheet.closeAria}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-base"
            style={{ background: "var(--surface-alt)", color: "var(--dim)" }}
          >
            ×
          </button>
        </div>
        <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--dim)" }}>
          {T.exportSheet.description}
        </p>
        {q.isPending && <p className="mt-3 text-sm" style={{ color: "var(--dim)" }}>{T.common.loading}</p>}
        {q.error && (
          <div className="mt-3">
            <p className="text-sm" style={{ color: "var(--danger)" }}>{T.common.loadFailed}</p>
            <button type="button" onClick={() => q.refetch()} className="mt-2 rounded-full px-4 py-2 text-sm font-bold" style={{ background: "var(--surface-alt)", color: "var(--text)" }}>
              {T.common.reload}
            </button>
          </div>
        )}
        {q.data && (
          <>
            <label className="sr-only" htmlFor="export-text">{T.exportSheet.textLabel}</label>
            <textarea
              id="export-text"
              readOnly
              value={q.data.text}
              rows={14}
              className="mt-3 min-h-0 w-full flex-1 rounded-2xl p-3 text-sm"
              style={{ background: "var(--surface-alt)", color: "var(--text)", border: "1px solid var(--border)" }}
            />
            {copyFailed && (
              <p className="mt-2 text-sm" style={{ color: "var(--danger)" }}>{T.exportSheet.copyFailed}</p>
            )}
            <button
              type="button"
              onClick={copyAll}
              className="mt-3 w-full rounded-full px-4 py-2.5 font-bold text-white"
              style={{ background: "var(--accent)" }}
            >
              {copied ? T.exportSheet.copied : T.exportSheet.copy}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function ConfirmSheet({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
  busy,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  return (
    <div className="sheet-overlay fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(10,6,20,0.55)" }} role="dialog" aria-modal="true" aria-label={title}>
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded-3xl p-5" style={{ background: "var(--surface)" }}>
        <h2 className="font-display text-lg font-bold" style={{ color: "var(--text)" }}>{title}</h2>
        <p className="mt-2 text-sm whitespace-pre-wrap" style={{ color: "var(--dim)" }}>{body}</p>
        <div className="mt-5 flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-full px-4 py-2.5 font-bold"
            style={{ background: "var(--surface-alt)", color: "var(--text)" }}
          >
            {T.common.cancel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="flex-1 rounded-full px-4 py-2.5 font-bold text-white disabled:opacity-50"
            style={{ background: "var(--danger)" }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ image edit

const CROP_VIEW = 280;
const CROP_OUT = 512;

/**
 * 戻し下書きを入力欄へ復元する。本文が変わった時だけ復元し、失敗の通知は
 * 失敗理由が付いている時（＝まだ表示済みになっていない失敗の初回表示）だけ出す。
 * サーバ側は会話を一度開くと失敗を表示済みにし、次回からは fail_reason を
 * 空で返すため、通知は次に開いた時から出なくなる（本文の復元だけが残る）。
 */
function useDraftRestore(
  draft: { body: string; fail_reason: string } | null | undefined,
  setDraftText: (v: string) => void,
  setNotice: (v: string) => void,
) {
  const restoredRef = useRef<string | null>(null);
  const noticedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!draft) {
      restoredRef.current = null;
      noticedRef.current = null;
      return;
    }
    if (draft.body && restoredRef.current !== draft.body) {
      restoredRef.current = draft.body;
      setDraftText(draft.body);
    }
    if (draft.fail_reason) {
      const key = `${draft.body}\n${draft.fail_reason}`;
      if (noticedRef.current !== key) {
        noticedRef.current = key;
        setNotice(T.draftRestore.failedNotice(failReasonLabel(draft.fail_reason)));
      }
    }
  }, [draft, setDraftText, setNotice]);
}

function ImageEditSheet({
  characterId,
  characterName,
  currentImageUrl,
  onClose,
}: {
  characterId: number;
  characterName: string;
  currentImageUrl: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [imgName, setImgName] = useState("");
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [error, setError] = useState("");
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  const save = useMutation({
    mutationFn: async (payload: { image_base64: string; image_mime: string }) =>
      await api.updateCharacterImage({ character_id: characterId, image_base64: payload.image_base64, image_mime: payload.image_mime }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["home"] });
      queryClient.invalidateQueries({ queryKey: ["chat", characterId] });
      queryClient.invalidateQueries({ queryKey: ["group"] });
      onClose();
    },
    onError: (e) => setError(errMsg(e, T.common.saveFailed)),
  });

  const baseScale = img ? Math.max(CROP_VIEW / img.naturalWidth, CROP_VIEW / img.naturalHeight) : 1;
  const scale = baseScale * zoom;
  // プレビューに実際に描く画像の表示サイズ（px）。枠より大きい実寸で描くことで、
  // ドラッグで枠外へ動かしても、元々はみ出していた部分がそのまま現れる。
  const dispW = img ? img.naturalWidth * scale : 0;
  const dispH = img ? img.naturalHeight * scale : 0;

  const clampOffset = (x: number, y: number, z: number, image: HTMLImageElement) => {
    const s = Math.max(CROP_VIEW / image.naturalWidth, CROP_VIEW / image.naturalHeight) * z;
    const maxX = Math.max(0, (image.naturalWidth * s - CROP_VIEW) / 2);
    const maxY = Math.max(0, (image.naturalHeight * s - CROP_VIEW) / 2);
    return { x: Math.min(maxX, Math.max(-maxX, x)), y: Math.min(maxY, Math.max(-maxY, y)) };
  };

  const onFile = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError(T.imageEdit.notImageFile);
      return;
    }
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      setImg(image);
      setImgName(file.name);
      setZoom(1);
      setOffset({ x: 0, y: 0 });
      setError("");
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      setError(T.imageEdit.loadImageFailed);
    };
    image.src = url;
  };

  const doSave = () => {
    if (!img) return;
    const canvas = document.createElement("canvas");
    canvas.width = CROP_OUT;
    canvas.height = CROP_OUT;
    const cx = canvas.getContext("2d");
    if (!cx) {
      setError(T.imageEdit.processFailed);
      return;
    }
    // プレビューで見えている範囲（元画像上の正方形の矩形）をそのまま切り取って
    // 512×512 へ描く。矩形は1辺 vis の正方形なので、縦横の倍率は必ず均等になる。
    const vis = CROP_VIEW / scale;
    const sx = img.naturalWidth / 2 - offset.x / scale - vis / 2;
    const sy = img.naturalHeight / 2 - offset.y / scale - vis / 2;
    cx.fillStyle = "#ffffff";
    cx.fillRect(0, 0, CROP_OUT, CROP_OUT);
    cx.drawImage(img, sx, sy, vis, vis, 0, 0, CROP_OUT, CROP_OUT);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    const base64 = dataUrl.split(",")[1] ?? "";
    if (!base64) {
      setError(T.imageEdit.processFailed);
      return;
    }
    save.mutate({ image_base64: base64, image_mime: "image/jpeg" });
  };

  return (
    <div className="sheet-overlay fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(10,6,20,0.55)" }} role="dialog" aria-modal="true" aria-label={T.imageEdit.title(characterName)}>
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded-3xl p-5" style={{ background: "var(--surface)" }}>
        <h2 className="font-display text-lg font-bold" style={{ color: "var(--text)" }}>{T.imageEdit.title(characterName)}</h2>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--dim)" }}>
          {T.imageEdit.description}
        </p>

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          aria-label={T.imageEdit.fileInputAria}
          onChange={(e) => {
            onFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="mt-4 w-full rounded-full px-4 py-2.5 font-bold"
          style={{ background: "var(--surface-alt)", color: "var(--text)" }}
        >
          {img ? T.imageEdit.chooseAnother : T.imageEdit.chooseFile}
        </button>
        {imgName && <p className="mt-1 truncate text-xs" style={{ color: "var(--dim)" }}>{imgName}</p>}

        {img ? (
          <>
            <div
              className="relative mx-auto mt-4 overflow-hidden rounded-2xl"
              style={{ width: CROP_VIEW, height: CROP_VIEW, background: "var(--surface-alt)", touchAction: "none", cursor: "grab" }}
              role="application"
              aria-label={T.imageEdit.cropAreaAria}
              onPointerDown={(e) => {
                (e.target as HTMLElement).setPointerCapture(e.pointerId);
                dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: offset.x, baseY: offset.y };
              }}
              onPointerMove={(e) => {
                const d = dragRef.current;
                if (!d) return;
                setOffset(clampOffset(d.baseX + (e.clientX - d.startX), d.baseY + (e.clientY - d.startY), zoom, img));
              }}
              onPointerUp={() => { dragRef.current = null; }}
              onPointerCancel={() => { dragRef.current = null; }}
            >
              <img
                src={img.src}
                alt={T.imageEdit.croppingAlt}
                draggable={false}
                className="absolute select-none"
                style={{
                  // 画像を「表示倍率での実寸」で描き、枠の中心＋ドラッグ量の位置に置く。
                  // object-fit: cover で要素いっぱいに描く方式だと、要素の箱の外側は
                  // 描画されず、ドラッグで最初に表示されていた領域の外が空白になる。
                  // 実寸描画なら枠外にはみ出した部分も描画済みで、ドラッグで現れる。
                  // maxWidth/maxHeight: none は Tailwind プリフライトの
                  // img { max-width: 100% } に幅だけ潰される事故（v1.6.1）の再発防止。
                  width: dispW,
                  height: dispH,
                  maxWidth: "none",
                  maxHeight: "none",
                  left: (CROP_VIEW - dispW) / 2 + offset.x,
                  top: (CROP_VIEW - dispH) / 2 + offset.y,
                }}
              />
            </div>
            <label className="mt-4 block text-sm font-bold" style={{ color: "var(--text)" }} htmlFor="crop-zoom">
              {T.imageEdit.zoom}
            </label>
            <input
              id="crop-zoom"
              type="range"
              min={1}
              max={3}
              step={0.01}
              value={zoom}
              onChange={(e) => {
                const z = Number(e.target.value);
                setZoom(z);
                setOffset((o) => clampOffset(o.x, o.y, z, img));
              }}
              className="mt-1 w-full"
              aria-label={T.imageEdit.zoom}
            />
            <p className="text-xs" style={{ color: "var(--dim)" }}>{T.imageEdit.previewNote}</p>
          </>
        ) : (
          currentImageUrl && (
            <div className="mt-4 flex items-center gap-3">
              <img src={currentImageUrl} alt={T.imageEdit.currentAlt(characterName)} width={64} height={64} className="rounded-full object-cover" style={{ width: 64, height: 64 }} />
              <p className="text-sm" style={{ color: "var(--dim)" }}>{T.imageEdit.currentNote}</p>
            </div>
          )
        )}

        {error && <p className="mt-2 text-sm" style={{ color: "var(--danger)" }}>{error}</p>}
        <div className="mt-4 flex gap-3">
          <button type="button" onClick={onClose} className="flex-1 rounded-full px-4 py-2.5 font-bold" style={{ background: "var(--surface-alt)", color: "var(--text)" }}>
            {T.common.cancel}
          </button>
          <button
            type="button"
            disabled={!img || save.isPending}
            onClick={doSave}
            className="flex-1 rounded-full px-4 py-2.5 font-bold text-white disabled:opacity-50"
            style={{ background: "var(--accent)" }}
          >
            {save.isPending ? T.common.saving : T.imageEdit.saveCropped}
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ character settings menu (v1.8)

function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1" />
    </svg>
  );
}

/** キャラ一覧の設定ボタンから開くメニュー。項目は今後ここへ追加していく。
 * 削除もここから行う（一覧行の×ボタンは廃止）。赤字の項目を選ぶと、呼び出し側が
 * 従来通りの確認ダイアログを挟んでから削除する。 */
function CharacterMenuSheet({
  character,
  onClose,
  onEditSettings,
  onEditImage,
  onRename,
  onSetCategory,
  onAutoTopic,
  onDelete,
}: {
  character: CharacterItem;
  onClose: () => void;
  onEditSettings: () => void;
  onEditImage: () => void;
  onRename: () => void;
  onSetCategory: () => void;
  onAutoTopic: () => void;
  onDelete: () => void;
}) {
  const items: { label: string; description: string; onSelect: () => void; danger?: boolean }[] = [
    { label: T.characterMenu.editSettings, description: T.characterMenu.editSettingsDesc, onSelect: onEditSettings },
    { label: T.characterMenu.editImage, description: T.characterMenu.editImageDesc, onSelect: onEditImage },
    { label: T.characterMenu.rename, description: T.characterMenu.renameDesc, onSelect: onRename },
    { label: T.characterMenu.setCategory, description: T.characterMenu.setCategoryDesc, onSelect: onSetCategory },
    { label: T.autoTopic.menuLabel, description: T.autoTopic.menuDescChat, onSelect: onAutoTopic },
    { label: T.characterMenu.deleteCharacter, description: T.characterMenu.deleteCharacterDesc, onSelect: onDelete, danger: true },
  ];
  return (
    <div className="sheet-overlay fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(10,6,20,0.55)" }} role="dialog" aria-modal="true" aria-label={T.characterMenu.menuAria(character.display_name)}>
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded-3xl p-5" style={{ background: "var(--surface)" }}>
        <div className="flex items-center gap-3">
          <Avatar imageUrl={character.image_url} name={character.display_name} themeColor={character.theme_color} size={40} />
          <h2 className="font-display min-w-0 flex-1 truncate text-lg font-bold" style={{ color: "var(--text)" }}>{T.characterMenu.title(character.display_name)}</h2>
        </div>
        <div className="mt-4 flex flex-col gap-2">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={item.onSelect}
              className="w-full rounded-2xl px-4 py-3 text-left"
              style={{ background: "var(--surface-alt)", color: "var(--text)" }}
            >
              <span className="block font-bold" style={item.danger ? { color: "var(--danger)" } : undefined}>{item.label}</span>
              <span className="mt-0.5 block text-xs" style={{ color: "var(--dim)" }}>{item.description}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="mt-4 w-full rounded-full px-4 py-2.5 font-bold"
          style={{ background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }}
        >
          {T.common.close}
        </button>
      </div>
    </div>
  );
}

/** 設定全体へのレビューのフォーム（「設定を編集する」画面の詳細設定画面に置く）。
 * 特定の発言ではなく設定全体への指摘を送ると、通常のレビューと同じ流れで
 * 見直し・自動適用され、結果はレビュー履歴に残る。 */
function SettingsReviewSection({ characterId, characterName }: { characterId: number; characterName: string }) {
  const queryClient = useQueryClient();
  const [reviewText, setReviewText] = useState("");
  const [reviewError, setReviewError] = useState("");
  const [reviewDone, setReviewDone] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const submitSettingsReview = useMutation({
    mutationFn: async (feedback: string) => await api.submitSettingsReview({ character_id: characterId, feedback }),
    onSuccess: () => {
      setReviewText("");
      setReviewError("");
      setReviewDone(true);
      queryClient.invalidateQueries({ queryKey: ["reviewHistory", characterId] });
    },
    onError: (e) => {
      setReviewDone(false);
      setReviewError(errMsg(e, T.characterSettings.reviewFailed));
    },
  });
  return (
    <>
      <div className="rounded-2xl p-3" style={{ background: "var(--surface-alt)" }}>
        <h3 className="text-sm font-bold" style={{ color: "var(--text)" }}>{T.characterSettings.reviewHeading}</h3>
        <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--dim)" }}>
          {T.characterSettings.reviewDesc}
        </p>
        <label className="mt-3 block text-sm font-bold" style={{ color: "var(--text)" }} htmlFor="settings-review-feedback">
          {T.characterSettings.reviewLabel}
        </label>
        <textarea
          id="settings-review-feedback"
          {...FIELDS.submitSettingsReview.feedback}
          value={reviewText}
          onChange={(e) => { setReviewText(e.target.value); setReviewError(""); setReviewDone(false); }}
          rows={3}
          placeholder={T.characterSettings.reviewPlaceholder}
          className="mt-1 w-full rounded-2xl p-3 text-sm"
          style={{ background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }}
        />
        {reviewError && <p className="mt-1 text-sm" style={{ color: "var(--danger)" }}>{reviewError}</p>}
        {reviewDone && (
          <p className="mt-1 text-sm" style={{ color: "var(--text)" }} role="status">{T.characterSettings.reviewRegistered}</p>
        )}
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            disabled={submitSettingsReview.isPending}
            onClick={() => {
              if (!reviewText.trim()) { setReviewError(T.characterSettings.reviewRequired); return; }
              submitSettingsReview.mutate(reviewText.trim());
            }}
            className="rounded-full px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
            style={{ background: "var(--accent)" }}
          >
            {submitSettingsReview.isPending ? T.characterSettings.reviewSending : T.characterSettings.reviewSubmit}
          </button>
          <button
            type="button"
            onClick={() => setShowHistory(true)}
            className="rounded-full px-3 py-2 text-xs font-bold"
            style={{ background: "var(--surface)", color: "var(--dim)" }}
          >
            {T.characterSettings.reviewOpenHistory}
          </button>
        </div>
      </div>
      {showHistory && (
        <ReviewHistorySheet characterId={characterId} characterName={characterName} onClose={() => setShowHistory(false)} />
      )}
    </>
  );
}

/** 詳細設定の画面（「設定を編集する」画面の保存ボタンの上にある「詳細設定」
 * ボタンから移動する）。レビュー関連の項目（設定全体へのレビュー）だけを
 * 集めた画面で、この画面で変更してそのまま保存できる（レビューは送信
 * ボタン）。本体の編集フォームとは独立しており、戻ると編集画面へ戻る。
 * 自動レビューの ON/OFF はここには無い: 自動レビューはキャラ設定ではなく、
 * チャット画面のレビューモードを ON にして送信した時に実行される。 */
function CharacterAdvancedSettingsSheet({
  character,
  onBack,
  onClose,
}: {
  character: CharacterItem;
  onBack: () => void;
  onClose: () => void;
}) {
  return (
    <div className="sheet-overlay fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(10,6,20,0.55)" }} role="dialog" aria-modal="true" aria-label={T.settingsEdit.advancedAria(character.display_name)}>
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded-3xl p-5" style={{ background: "var(--surface)" }}>
        <div className="flex items-start justify-between gap-3">
          <h2 className="font-display text-lg font-bold" style={{ color: "var(--text)" }}>{T.settingsEdit.advancedTitle}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={T.common.close}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-base"
            style={{ background: "var(--surface-alt)", color: "var(--dim)" }}
          >
            ×
          </button>
        </div>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--dim)" }}>
          {T.settingsEdit.advancedIntro}
        </p>
        <div className="mt-4">
          <SettingsReviewSection characterId={character.id} characterName={character.display_name} />
        </div>
        <button
          type="button"
          onClick={onBack}
          className="mt-5 w-full rounded-full px-4 py-2.5 font-bold"
          style={{ background: "var(--surface-alt)", color: "var(--text)" }}
        >
          {T.settingsEdit.advancedBack}
        </button>
      </div>
    </div>
  );
}

type AutoReviewItem = ApiResponse<typeof api, "getChatState">["auto_reviews"][number];

/** 自動レビューの生記録（送ったプロンプト全文と返ってきたレスポンス全文）。
 * 全体ログの生成記録と同じ分け方・見出し・見た目で2つに分けて見せる。
 * 記録が無い自動レビュー（この記録が始まる前に実行された分など）では
 * 何も表示しない。 */
function ReviewPromptResponse({ prompt, response }: { prompt: string; response: string }) {
  if (!prompt && !response) return null;
  return (
    <div className="mt-3 flex flex-col gap-3">
      {prompt && (
        <div>
          <p className="text-xs font-bold" style={{ color: "var(--dim)" }}>{T.logs.requestHeading}</p>
          <pre className="mt-1 max-h-80 overflow-auto rounded-xl p-3 text-xs leading-relaxed whitespace-pre-wrap break-words" style={{ background: "var(--surface)", color: "var(--text)" }}>
            {prompt}
          </pre>
        </div>
      )}
      {response && (
        <div>
          <p className="text-xs font-bold" style={{ color: "var(--dim)" }}>{T.logs.responseHeading}</p>
          <pre className="mt-1 max-h-80 overflow-auto rounded-xl p-3 text-xs leading-relaxed whitespace-pre-wrap break-words" style={{ background: "var(--surface)", color: "var(--text)" }}>
            {response}
          </pre>
        </div>
      )}
    </div>
  );
}

/** 自動レビューの結果シート。自動レビューが走った回の生成バッチの後ろの
 * 「レビュー結果」ボタンから開く。その回の結果（実行待ち・実行中・変更あり・
 * 変更なし・失敗の状態と、差分・改訂の意図）をキャラごとに表示する。 */
function AutoReviewResultSheet({ reviews, onClose }: { reviews: AutoReviewItem[]; onClose: () => void }) {
  return (
    <div className="sheet-overlay fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(10,6,20,0.55)" }} role="dialog" aria-modal="true" aria-label={T.autoReview.resultTitle}>
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded-3xl p-5" style={{ background: "var(--surface)" }}>
        <div className="flex items-start justify-between gap-2">
          <h2 className="font-display text-lg font-bold" style={{ color: "var(--text)" }}>{T.autoReview.resultTitle}</h2>
          <button type="button" onClick={onClose} aria-label={T.autoReview.closeAria} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full" style={{ background: "var(--surface-alt)", color: "var(--dim)" }}>
            ×
          </button>
        </div>
        <div className="mt-4 flex flex-col gap-4">
          {reviews.map((r) => (
            <article key={r.review_id} className="rounded-2xl p-3" style={{ background: "var(--surface-alt)" }}>
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold" style={{ color: "var(--text)" }}>{r.character_name}</span>
                <span
                  className="rounded-full px-2 py-0.5 text-xs font-bold"
                  style={{
                    background: "var(--surface)",
                    color: r.status === "failed" ? "var(--danger)" : r.status === "done" ? "var(--gold)" : "var(--dim)",
                  }}
                >
                  {T.autoReview.statusLabels[r.status] ?? r.status}
                </span>
                {r.reverted_at && (
                  <span className="rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: "var(--surface)", color: "var(--danger)" }}>{T.reviewHistory.revertedBadge}</span>
                )}
              </div>
              {(r.status === "pending" || r.status === "processing") && (
                <p className="mt-2 text-sm" style={{ color: "var(--dim)" }}>{T.autoReview.waitingNote}</p>
              )}
              {r.status === "failed" && (
                <>
                  <p className="mt-2 text-sm" style={{ color: "var(--danger)" }}>{reviewFailLabel(r.fail_reason)}{T.autoReview.failedNoteSuffix}</p>
                  {r.fail_detail ? (
                    <p className="mt-1 text-xs whitespace-pre-wrap break-words" style={{ color: "var(--dim)" }}>{T.reviewHistory.failDetailLabel(r.fail_detail)}</p>
                  ) : null}
                </>
              )}
              {r.status === "no_change" && (
                <p className="mt-2 text-sm" style={{ color: "var(--dim)" }}>{T.autoReview.noChangeNote}</p>
              )}
              {r.intent.trim() && (
                <>
                  <p className="mt-3 text-xs font-bold" style={{ color: "var(--dim)" }}>{T.autoReview.intentHeading}</p>
                  <p className="mt-0.5 text-sm whitespace-pre-wrap" style={{ color: "var(--text)" }}>{r.intent}</p>
                </>
              )}
              {r.diff.length > 0 && (
                <>
                  <p className="mt-3 text-xs font-bold" style={{ color: "var(--dim)" }}>{T.autoReview.diffHeading(r.diff.length)}</p>
                  <div className="mt-1 flex flex-col gap-2">
                    {r.diff.map((d, i) => (
                      <div key={i} className="rounded-xl p-2.5" style={{ background: "var(--surface)" }}>
                        <p className="text-xs font-bold break-all" style={{ color: "var(--gold)" }}>{d.path}</p>
                        <DiffValuePair before={d.before} after={d.after} />
                      </div>
                    ))}
                  </div>
                </>
              )}
              {r.reverted_at && (
                <p className="mt-2 text-xs" style={{ color: "var(--dim)" }}>{T.autoReview.revertedNote}</p>
              )}
              <ReviewPromptResponse prompt={r.prompt_text} response={r.response_text} />
            </article>
          ))}
        </div>
        <p className="mt-3 text-xs leading-relaxed" style={{ color: "var(--dim)" }}>{T.autoReview.historyHint}</p>
      </div>
    </div>
  );
}

/** その回の生成バッチの後ろに置く「レビュー結果」ボタン。 */
function AutoReviewResultButton({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="flex justify-center">
      <button
        type="button"
        onClick={onOpen}
        aria-label={T.autoReview.resultButtonAria}
        className="rounded-full px-3.5 py-1.5 text-xs font-bold"
        style={{ background: "var(--surface)", color: "var(--dim)", border: "1px solid var(--border)" }}
      >
        {T.autoReview.resultButton}
      </button>
    </div>
  );
}

type SettingsFormData = ApiResponse<typeof api, "getCharacterSettingsForm">;

/** 新規作成フォームの初期値（全項目空）。名前だけ入力すれば作成できる。 */
const EMPTY_SETTINGS_FORM: SettingsFormData = {
  id: 0,
  display_name: "",
  editable: true,
  name: "",
  summary: "",
  greeting: "",
  background_text: "",
  background_links: [],
  link_summary: "",
  portrayal_focus: "",
  video_urls: [],
  video_notes: "",
  user_relationship: "",
  call_user_as: "",
  speech_style: "",
  speech_first_person: "",
  speech_second_person: "",
  speech_catchphrase: "",
  speech_memo: "",
  avatar_memory: "",
  elements: [],
  traits: [],
};

const editInputStyle = {
  background: "var(--surface-alt)",
  color: "var(--text)",
  border: "1px solid var(--border)",
} as const;

function EditTextField({
  label,
  fieldProps,
  value,
  onChange,
}: {
  label: string;
  fieldProps?: Record<string, unknown>;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="block text-sm font-bold" style={{ color: "var(--text)" }}>
        {label}
        <input
          {...fieldProps}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="mt-1 w-full rounded-2xl px-3 py-2.5 font-normal"
          style={editInputStyle}
        />
      </label>
    </div>
  );
}

function EditAreaField({
  label,
  fieldProps,
  value,
  onChange,
  rows = 4,
  hint,
}: {
  label: string;
  fieldProps?: Record<string, unknown>;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  hint?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-bold" style={{ color: "var(--text)" }}>
        {label}
        <textarea
          {...fieldProps}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={rows}
          className="mt-1 w-full rounded-2xl px-3 py-2.5 font-normal"
          style={editInputStyle}
        />
      </label>
      {hint && (
        <p className="mt-1 text-xs" style={{ color: "var(--dim)" }}>{hint}</p>
      )}
    </div>
  );
}

function EditSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="font-display text-base font-bold" style={{ color: "var(--text)" }}>{title}</h3>
      <div className="mt-2 flex flex-col gap-3">{children}</div>
    </section>
  );
}

type TraitDraft = { id: string; label: string; examplesText: string; enabled: boolean };
type ElementDraft = { key: string; value: string };

/** 設定の編集フォーム本体。初期値は取得済みのフォームデータから作る。
 * character が null の場合は新規作成モードで、同じ項目フォーマットのまま
 * createCharacter へ送る（詳細設定ボタンは出さない）。 */
function CharacterSettingsEditForm({
  character,
  initial,
  onClose,
  onOpenAdvanced,
}: {
  character: CharacterItem | null;
  initial: SettingsFormData;
  onClose: () => void;
  onOpenAdvanced?: () => void;
}) {
  const queryClient = useQueryClient();
  const isCreate = character === null;
  const F = isCreate ? FIELDS.createCharacter : FIELDS.updateCharacterSettings;
  const [name, setName] = useState(initial.name);
  const [summary, setSummary] = useState(initial.summary);
  const [greeting, setGreeting] = useState(initial.greeting);
  const [backgroundText, setBackgroundText] = useState(initial.background_text);
  const [linksText, setLinksText] = useState(initial.background_links.join("\n"));
  const [linkSummary, setLinkSummary] = useState(initial.link_summary);
  const [portrayalFocus, setPortrayalFocus] = useState(initial.portrayal_focus);
  const [videoUrlsText, setVideoUrlsText] = useState(initial.video_urls.join("\n"));
  const [videoNotes, setVideoNotes] = useState(initial.video_notes);
  const [userRelationship, setUserRelationship] = useState(initial.user_relationship);
  const [callUserAs, setCallUserAs] = useState(initial.call_user_as);
  const [speechStyle, setSpeechStyle] = useState(initial.speech_style);
  const [firstPerson, setFirstPerson] = useState(initial.speech_first_person);
  const [secondPerson, setSecondPerson] = useState(initial.speech_second_person);
  const [catchphrase, setCatchphrase] = useState(initial.speech_catchphrase);
  const [speechMemo, setSpeechMemo] = useState(initial.speech_memo);
  const [avatarMemory, setAvatarMemory] = useState(initial.avatar_memory);
  const [elements, setElements] = useState<ElementDraft[]>(initial.elements);
  const [traits, setTraits] = useState<TraitDraft[]>(
    initial.traits.map((t) => ({ id: t.id, label: t.label, examplesText: t.examples.join("\n"), enabled: t.enabled })),
  );
  const [error, setError] = useState("");

  const save = useMutation({
    mutationFn: async () => {
      const fields = {
        name: name.trim(),
        summary,
        greeting,
        background_text: backgroundText,
        background_links: linksText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
        link_summary: linkSummary,
        portrayal_focus: portrayalFocus,
        video_urls: videoUrlsText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
        video_notes: videoNotes,
        user_relationship: userRelationship,
        call_user_as: callUserAs,
        speech_style: speechStyle,
        speech_first_person: firstPerson,
        speech_second_person: secondPerson,
        speech_catchphrase: catchphrase,
        speech_memo: speechMemo,
        avatar_memory: avatarMemory,
        elements,
        traits: traits.map((t) => ({
          id: t.id,
          label: t.label,
          examples: t.examplesText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
          enabled: t.enabled,
        })),
      };
      return character === null
        ? await api.createCharacter(fields)
        : await api.updateCharacterSettings({ character_id: character.id, ...fields });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["home"] });
      if (character !== null) {
        queryClient.invalidateQueries({ queryKey: ["chat", character.id] });
        queryClient.invalidateQueries({ queryKey: ["group"] });
        queryClient.invalidateQueries({ queryKey: ["character-settings", character.id] });
        queryClient.invalidateQueries({ queryKey: ["character-settings-form", character.id] });
      }
      onClose();
    },
    onError: (e) => setError(errMsg(e, T.common.saveFailed)),
  });

  const submit = () => {
    if (!name.trim()) {
      setError(T.settingsEdit.nameRequired);
      return;
    }
    setError("");
    save.mutate();
  };

  const updateTrait = (idx: number, patch: Partial<TraitDraft>) =>
    setTraits((prev) => prev.map((t, i) => (i === idx ? { ...t, ...patch } : t)));
  const updateElement = (idx: number, patch: Partial<ElementDraft>) =>
    setElements((prev) => prev.map((e, i) => (i === idx ? { ...e, ...patch } : e)));

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm leading-relaxed" style={{ color: "var(--dim)" }}>
        {isCreate ? T.createCharacter.intro : T.settingsEdit.intro}
      </p>

      <EditSection title={T.settingsEdit.sectionBasic}>
        <EditTextField label={T.settingsEdit.labelName} fieldProps={F.name} value={name} onChange={setName} />
        <EditAreaField label={T.settingsEdit.labelSummary} fieldProps={F.summary} value={summary} onChange={setSummary} rows={3} />
        <EditAreaField label={T.settingsEdit.labelGreeting} fieldProps={F.greeting} value={greeting} onChange={setGreeting} rows={3} />
        <EditAreaField label={T.settingsEdit.labelAvatarMemory} fieldProps={F.avatar_memory} value={avatarMemory} onChange={setAvatarMemory} rows={3} />
      </EditSection>

      <EditSection title={T.settingsEdit.sectionBackground}>
        <EditAreaField label={T.settingsEdit.labelBackgroundText} fieldProps={F.background_text} value={backgroundText} onChange={setBackgroundText} rows={8} />
        <EditAreaField label={T.settingsEdit.labelLinks} value={linksText} onChange={setLinksText} rows={3} hint={T.settingsEdit.hintOnePerLine} />
        <EditAreaField label={T.settingsEdit.labelLinkSummary} fieldProps={F.link_summary} value={linkSummary} onChange={setLinkSummary} rows={4} />
        <EditAreaField label={T.settingsEdit.labelPortrayalFocus} fieldProps={F.portrayal_focus} value={portrayalFocus} onChange={setPortrayalFocus} rows={3} hint={T.settingsEdit.hintPortrayalFocus} />
        <EditAreaField label={T.settingsEdit.labelVideoUrls} value={videoUrlsText} onChange={setVideoUrlsText} rows={3} hint={T.settingsEdit.hintOnePerLine} />
      </EditSection>

      <EditSection title={T.settingsEdit.sectionSpeech}>
        <EditAreaField label={T.settingsEdit.labelSpeechStyle} fieldProps={F.speech_style} value={speechStyle} onChange={setSpeechStyle} rows={4} />
        <EditTextField label={T.settingsEdit.labelFirstPerson} fieldProps={F.speech_first_person} value={firstPerson} onChange={setFirstPerson} />
        <EditTextField label={T.settingsEdit.labelSecondPerson} fieldProps={F.speech_second_person} value={secondPerson} onChange={setSecondPerson} />
        <EditAreaField label={T.settingsEdit.labelCatchphrase} fieldProps={F.speech_catchphrase} value={catchphrase} onChange={setCatchphrase} rows={2} />
        <EditAreaField label={T.settingsEdit.labelSpeechMemo} fieldProps={F.speech_memo} value={speechMemo} onChange={setSpeechMemo} rows={3} />
        <EditAreaField label={T.settingsEdit.labelVideoNotes} fieldProps={F.video_notes} value={videoNotes} onChange={setVideoNotes} rows={4} hint={T.settingsEdit.hintVideoNotes} />
      </EditSection>

      <EditSection title={T.settingsEdit.sectionRelation}>
        <EditAreaField label={T.settingsEdit.labelUserRelationship} fieldProps={F.user_relationship} value={userRelationship} onChange={setUserRelationship} rows={3} />
        <EditTextField label={T.settingsEdit.labelCallUserAs} fieldProps={F.call_user_as} value={callUserAs} onChange={setCallUserAs} />
      </EditSection>

      <EditSection title={T.settingsEdit.sectionAppearance}>
        <div className="flex flex-col gap-2">
          {elements.map((el, i) => (
            <div key={i} className="flex items-start gap-2">
              <input
                aria-label={T.settingsEdit.elementKeyAria(i)}
                value={el.key}
                onChange={(e) => updateElement(i, { key: e.target.value })}
                placeholder={T.settingsEdit.elementKeyPlaceholder}
                className="w-28 shrink-0 rounded-2xl px-3 py-2.5 text-sm"
                style={editInputStyle}
              />
              <input
                aria-label={T.settingsEdit.elementValueAria(i)}
                value={el.value}
                onChange={(e) => updateElement(i, { value: e.target.value })}
                placeholder={T.settingsEdit.elementValuePlaceholder}
                className="min-w-0 flex-1 rounded-2xl px-3 py-2.5 text-sm"
                style={editInputStyle}
              />
              <button
                type="button"
                aria-label={T.settingsEdit.elementDeleteAria(i)}
                onClick={() => setElements((prev) => prev.filter((_, j) => j !== i))}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-base"
                style={{ background: "var(--surface-alt)", color: "var(--danger)" }}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setElements((prev) => [...prev, { key: "", value: "" }])}
            className="self-start rounded-full px-4 py-2 text-sm font-bold"
            style={{ background: "var(--surface-alt)", color: "var(--text)" }}
          >
            {T.settingsEdit.addElement}
          </button>
        </div>
      </EditSection>

      <EditSection title={T.settingsEdit.sectionTraits}>
        <div className="flex flex-col gap-3">
          {traits.map((t, i) => (
            <div key={i} className="rounded-2xl p-3" style={{ background: "var(--surface-alt)" }}>
              <div className="flex items-center gap-2">
                <input
                  aria-label={T.settingsEdit.traitNameAria(i)}
                  value={t.label}
                  onChange={(e) => updateTrait(i, { label: e.target.value })}
                  placeholder={T.settingsEdit.traitNamePlaceholder}
                  className="min-w-0 flex-1 rounded-xl px-3 py-2 text-sm font-bold"
                  style={{ background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }}
                />
                <button
                  type="button"
                  aria-label={T.settingsEdit.traitDeleteAria(i)}
                  onClick={() => setTraits((prev) => prev.filter((_, j) => j !== i))}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-base"
                  style={{ background: "var(--surface)", color: "var(--danger)" }}
                >
                  ×
                </button>
              </div>
              <label className="mt-2 block text-xs font-bold" style={{ color: "var(--dim)" }}>
                {T.settingsEdit.traitExamplesLabel}
                <textarea
                  value={t.examplesText}
                  onChange={(e) => updateTrait(i, { examplesText: e.target.value })}
                  rows={2}
                  className="mt-1 w-full rounded-xl px-3 py-2 text-sm font-normal"
                  style={{ background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }}
                />
              </label>
              <label className="mt-2 flex items-center gap-2 text-sm" style={{ color: "var(--text)" }}>
                <input
                  type="checkbox"
                  checked={t.enabled}
                  onChange={(e) => updateTrait(i, { enabled: e.target.checked })}
                  className="h-5 w-5"
                />
                {T.settingsEdit.traitEnabled}
              </label>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setTraits((prev) => [...prev, { id: "", label: "", examplesText: "", enabled: true }])}
            className="self-start rounded-full px-4 py-2 text-sm font-bold"
            style={{ background: "var(--surface-alt)", color: "var(--text)" }}
          >
            {T.settingsEdit.addTrait}
          </button>
        </div>
      </EditSection>

      {error && <p className="text-sm" style={{ color: "var(--danger)" }}>{error}</p>}
      {onOpenAdvanced && (
        <button
          type="button"
          onClick={onOpenAdvanced}
          className="w-full rounded-full px-4 py-2.5 font-bold"
          style={{ background: "var(--surface-alt)", color: "var(--text)" }}
        >
          {T.settingsEdit.advancedButton}
        </button>
      )}
      <div className="flex gap-3">
        <button type="button" onClick={onClose} className="flex-1 rounded-full px-4 py-2.5 font-bold" style={{ background: "var(--surface-alt)", color: "var(--text)" }}>
          {T.common.cancel}
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={save.isPending}
          className="flex-1 rounded-full px-4 py-2.5 font-bold text-white disabled:opacity-50"
          style={{ background: "var(--accent)" }}
        >
          {isCreate
            ? save.isPending
              ? T.createCharacter.submitting
              : T.createCharacter.submit
            : save.isPending
              ? T.common.saving
              : T.common.save}
        </button>
      </div>
    </div>
  );
}

/** 設定を編集するシート（設定メニューから開く）。旧「概要を確認する」画面は
 * この画面へ統合した: 概要（表示名・元の名前・取り込み元ID・登録日時）を
 * 上部に表示し、その下に編集フォームを置く。生成に使われる設定本文・関係と
 * 呼び方（出力）は場所を取るため常時表示せず、「出力を確認する」ボタンを
 * 押した時だけ広げる。レビュー関連の項目（設定全体へのレビュー）は本体
 * フォームには置かず、保存ボタンの上の「詳細設定」ボタンから詳細設定の
 * 画面（CharacterAdvancedSettingsSheet）へ移動して扱う。 */
function CharacterSettingsEditSheet({ character, onClose }: { character: CharacterItem; onClose: () => void }) {
  const [showOutput, setShowOutput] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const q = useQuery({
    queryKey: ["character-settings-form", character.id],
    queryFn: () => api.getCharacterSettingsForm({ character_id: character.id }),
  });
  const overview = useQuery({
    queryKey: ["character-settings", character.id],
    queryFn: () => api.getCharacterSettings({ character_id: character.id }),
  });
  const o = overview.data;
  return (
    <div className="sheet-overlay fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(10,6,20,0.55)" }} role="dialog" aria-modal="true" aria-label={T.settingsEdit.sheetAria(character.display_name)}>
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded-3xl p-5" style={{ background: "var(--surface)" }}>
        <div className="flex items-start justify-between gap-3">
          <h2 className="font-display text-lg font-bold" style={{ color: "var(--text)" }}>{T.settingsEdit.title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={T.common.close}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-base"
            style={{ background: "var(--surface-alt)", color: "var(--dim)" }}
          >
            ×
          </button>
        </div>
        {o && (
          <div className="mt-3 flex flex-col gap-4">
            <h3 className="text-sm font-bold" style={{ color: "var(--text)" }}>{T.settingsEdit.sectionOverview}</h3>
            <dl className="flex flex-col gap-1.5 text-sm">
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 font-bold" style={{ color: "var(--dim)" }}>{T.characterSettings.displayName}</dt>
                <dd style={{ color: "var(--text)" }}>{o.display_name}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 font-bold" style={{ color: "var(--dim)" }}>{T.characterSettings.originalName}</dt>
                <dd style={{ color: "var(--text)" }}>{o.name}</dd>
              </div>
              {o.source_profile_id && (
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0 font-bold" style={{ color: "var(--dim)" }}>{T.characterSettings.sourceProfileId}</dt>
                  <dd className="break-all" style={{ color: "var(--text)" }}>{o.source_profile_id}</dd>
                </div>
              )}
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 font-bold" style={{ color: "var(--dim)" }}>{T.characterSettings.createdAt}</dt>
                <dd style={{ color: "var(--text)" }}>{new Date(o.created_at).toLocaleString("ja-JP")}</dd>
              </div>
            </dl>
            <div>
              <button
                type="button"
                onClick={() => setShowOutput((v) => !v)}
                aria-expanded={showOutput}
                className="rounded-full px-4 py-2 text-sm font-bold"
                style={{ background: "var(--surface-alt)", color: "var(--text)" }}
              >
                {showOutput ? T.settingsEdit.hideOutput : T.settingsEdit.showOutput}
              </button>
              {showOutput && (
                <div className="mt-3 flex flex-col gap-4">
                  <div>
                    <h3 className="text-sm font-bold" style={{ color: "var(--text)" }}>{T.characterSettings.settingsTextHeading}</h3>
                    <p className="mt-1.5 rounded-2xl p-3 text-sm leading-relaxed whitespace-pre-wrap" style={{ background: "var(--surface-alt)", color: "var(--text)" }}>
                      {o.settings_text}
                    </p>
                  </div>
                  {o.relation_text && (
                    <div>
                      <h3 className="text-sm font-bold" style={{ color: "var(--text)" }}>{T.characterSettings.relationTextHeading}</h3>
                      <p className="mt-1.5 rounded-2xl p-3 text-sm leading-relaxed whitespace-pre-wrap" style={{ background: "var(--surface-alt)", color: "var(--text)" }}>
                        {o.relation_text}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
            <p className="text-xs leading-relaxed" style={{ color: "var(--dim)" }}>
              {T.settingsEdit.overviewNote} {T.characterSettings.footerNote}
            </p>
          </div>
        )}
        {q.isPending && <p className="mt-3 text-sm" style={{ color: "var(--dim)" }}>{T.common.loading}</p>}
        {q.error && (
          <div className="mt-3">
            <p className="text-sm" style={{ color: "var(--danger)" }}>{T.common.loadFailed}</p>
            <button type="button" onClick={() => q.refetch()} className="mt-2 rounded-full px-4 py-2 text-sm font-bold" style={{ background: "var(--surface-alt)", color: "var(--text)" }}>
              {T.common.reload}
            </button>
          </div>
        )}
        {q.data && !q.data.editable && (
          <>
            <p className="mt-3 text-sm leading-relaxed" style={{ color: "var(--dim)" }}>
              {T.settingsEdit.notEditable}
            </p>
            <button
              type="button"
              onClick={() => setShowAdvanced(true)}
              className="mt-3 w-full rounded-full px-4 py-2.5 font-bold"
              style={{ background: "var(--surface-alt)", color: "var(--text)" }}
            >
              {T.settingsEdit.advancedButton}
            </button>
          </>
        )}
        {q.data && q.data.editable && (
          <div className="mt-3">
            <CharacterSettingsEditForm character={character} initial={q.data} onClose={onClose} onOpenAdvanced={() => setShowAdvanced(true)} />
          </div>
        )}
      </div>
      {showAdvanced && (
        <CharacterAdvancedSettingsSheet
          character={character}
          onBack={() => setShowAdvanced(false)}
          onClose={onClose}
        />
      )}
    </div>
  );
}

/** キャラクターを一から作成するシート（キャラ追加の導線から開く）。
 * 「設定を編集する」と同じ項目フォーマットのフォームを使い、名前だけ
 * 必須で作成できる。作成したキャラは取り込みで追加したキャラと同じ扱い。 */
function CharacterCreateSheet({ onClose }: { onClose: () => void }) {
  return (
    <div className="sheet-overlay fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(10,6,20,0.55)" }} role="dialog" aria-modal="true" aria-label={T.createCharacter.sheetAria}>
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded-3xl p-5" style={{ background: "var(--surface)" }}>
        <div className="flex items-start justify-between gap-3">
          <h2 className="font-display text-lg font-bold" style={{ color: "var(--text)" }}>{T.createCharacter.title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={T.common.close}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-base"
            style={{ background: "var(--surface-alt)", color: "var(--dim)" }}
          >
            ×
          </button>
        </div>
        <div className="mt-3">
          <CharacterSettingsEditForm character={null} initial={EMPTY_SETTINGS_FORM} onClose={onClose} />
        </div>
      </div>
    </div>
  );
}

/** 表示名の変更シート。設定本文・会話履歴には影響しない。 */
/** 名前変更シートの共通形（キャラの表示名／グループ名で共用）。
 * 文言・入力欄の属性・保存処理・保存後に無効化するクエリは呼び出し側から渡す。 */
function RenameSheet({
  texts,
  inputId,
  fieldProps,
  currentName,
  onSave,
  invalidateKeys,
  onClose,
  extra,
  extraChanged,
}: {
  texts: { title: string; description: string; label: string; nameRequired: string };
  inputId: string;
  fieldProps: Record<string, unknown>;
  currentName: string;
  onSave: (name: string) => Promise<unknown>;
  invalidateKeys: unknown[][];
  onClose: () => void;
  /** 名前入力欄の下へ差し込む追加の設定UI（グループ名の「おまかせ」等）。 */
  extra?: ReactNode;
  /** extra 側の値が初期値から変わっているか。名前が同じでも保存が必要になる。 */
  extraChanged?: boolean;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(currentName);
  const [error, setError] = useState("");
  const rename = useMutation({
    mutationFn: async (v: string) => await onSave(v),
    onSuccess: () => {
      for (const key of invalidateKeys) queryClient.invalidateQueries({ queryKey: key });
      onClose();
    },
    onError: (e) => setError(errMsg(e, T.common.changeFailed)),
  });
  const submit = () => {
    const v = name.trim();
    if (!v) {
      setError(texts.nameRequired);
      return;
    }
    if (v === currentName && !extraChanged) {
      onClose();
      return;
    }
    setError("");
    rename.mutate(v);
  };
  return (
    <div className="sheet-overlay fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(10,6,20,0.55)" }} role="dialog" aria-modal="true" aria-label={texts.title}>
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded-3xl p-5" style={{ background: "var(--surface)" }}>
        <h2 className="font-display text-lg font-bold" style={{ color: "var(--text)" }}>{texts.title}</h2>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--dim)" }}>
          {texts.description}
        </p>
        <label className="mt-4 block text-sm font-bold" style={{ color: "var(--text)" }} htmlFor={inputId}>
          {texts.label}
        </label>
        <input
          id={inputId}
          {...(fieldProps as InputHTMLAttributes<HTMLInputElement>)}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 w-full rounded-2xl px-3 py-2.5"
          style={{ background: "var(--surface-alt)", color: "var(--text)", border: "1px solid var(--border)" }}
        />
        {extra}
        {error && <p className="mt-2 text-sm" style={{ color: "var(--danger)" }}>{error}</p>}
        <div className="mt-4 flex gap-3">
          <button type="button" onClick={onClose} className="flex-1 rounded-full px-4 py-2.5 font-bold" style={{ background: "var(--surface-alt)", color: "var(--text)" }}>
            {T.common.cancel}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={rename.isPending}
            className="flex-1 rounded-full px-4 py-2.5 font-bold text-white disabled:opacity-50"
            style={{ background: "var(--accent)" }}
          >
            {rename.isPending ? T.common.saving : T.common.change}
          </button>
        </div>
      </div>
    </div>
  );
}

function RenameCharacterSheet({ character, onClose }: { character: CharacterItem; onClose: () => void }) {
  return (
    <RenameSheet
      texts={T.renameCharacter}
      inputId="rename-display-name"
      fieldProps={FIELDS.renameCharacter.display_name}
      currentName={character.display_name}
      onSave={async (v) => await api.renameCharacter({ character_id: character.id, display_name: v })}
      invalidateKeys={[["home"], ["chat", character.id], ["group"]]}
      onClose={onClose}
    />
  );
}

// ------------------------------------------------------------------ categories (v1.10 / 設計書 4.11)

type CategoryItem = Home["categories"][number];

type CategoryTreeEntry = { cat: CategoryItem; depth: number };

/**
 * カテゴリを階層（ツリー）順に並べた一覧を返す（v1.26・階層化）。
 * 親→子の順に辿り、各項目に深さ（最上位=0）を持たせる。兄弟の並びは登録順。
 * 親が存在しないカテゴリは最上位として扱い、循環などで辿れなかったものも
 * 表示から消えないよう最上位として末尾に置く。
 */
function categoryTreeEntries(categories: CategoryItem[]): CategoryTreeEntry[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const childrenByParent = new Map<number | null, CategoryItem[]>();
  for (const c of categories) {
    const key = c.parent_id != null && byId.has(c.parent_id) ? c.parent_id : null;
    const arr = childrenByParent.get(key) ?? [];
    arr.push(c);
    childrenByParent.set(key, arr);
  }
  const out: CategoryTreeEntry[] = [];
  const visited = new Set<number>();
  const walk = (parentKey: number | null, depth: number) => {
    for (const c of childrenByParent.get(parentKey) ?? []) {
      if (visited.has(c.id)) continue;
      visited.add(c.id);
      out.push({ cat: c, depth });
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  for (const c of categories) {
    if (!visited.has(c.id)) out.push({ cat: c, depth: 0 });
  }
  return out;
}

// カテゴリ木ロジック（子孫展開・祖先集合・祖先除外）の実体は、サーバと共用の
// 純粋関数モジュール（server/src/category-tree）が正（冗長性レビュー B-6 で
// 一本化。以前は両側にほぼ逐語の二重実装があった）。ここでは応答の形
// （parent_id）を共用モジュールの形（parentId）へ写して委譲するだけにする。
function toCategoryTreeNodes(categories: CategoryItem[]): CategoryTreeNode[] {
  return categories.map((c) => ({ id: c.id, parentId: c.parent_id ?? null }));
}

/** カテゴリ id の子孫ID集合（自分自身を含む）。絞り込みの共通判定に使う（v1.26）。 */
function categoryDescendantIdSet(categories: CategoryItem[], id: number): Set<number> {
  return categoryDescendantIds(toCategoryTreeNodes(categories), id);
}

/** カテゴリ id の祖先ID集合（親・祖父…。自分自身は含まない）（v1.27・設計書 v1.7.1）。 */
function categoryAncestorIdSet(categories: CategoryItem[], id: number): Set<number> {
  return categoryAncestorIds(toCategoryTreeNodes(categories), id);
}

/**
 * 割り当て集合から祖先側を落として子だけを残す（v1.27・設計書 v1.7.1）。
 * サーバ側の強制と同じ規則を、割り当てシートの初期表示・操作にも適用する。
 */
function pruneAncestorCategoryIds(categories: CategoryItem[], ids: number[]): number[] {
  return pruneAncestorCategoryIdsShared(toCategoryTreeNodes(categories), ids);
}

/** キャラがカテゴリ filterId（その子孫カテゴリを含む）に属するか（v1.26）。 */
function charMatchesCategory(c: CharacterItem, categories: CategoryItem[], filterId: number): boolean {
  const set = categoryDescendantIdSet(categories, filterId);
  return charCategoryIds(c).some((cid) => set.has(cid));
}

/** カテゴリ絞り込みの値: "all" = 全員 / "none" = 未分類のみ / 数値 = そのカテゴリ（子孫カテゴリを含む）。 */
type CategoryFilter = "all" | "none" | number;

/** キャラがカテゴリ絞り込みに一致するか（一覧・グループ作成・参加者変更で共用）。 */
function charMatchesFilter(c: CharacterItem, categories: CategoryItem[], filter: CategoryFilter): boolean {
  if (filter === "all") return true;
  if (filter === "none") return charCategoryIds(c).length === 0;
  return charMatchesCategory(c, categories, filter);
}

/** カテゴリ絞り込みセレクト（ラベル＋セレクト）。値の相互変換もここで担う。 */
function CategoryFilterSelect({
  id,
  categories,
  value,
  onChange,
}: {
  id: string;
  categories: CategoryItem[];
  value: CategoryFilter;
  onChange: (next: CategoryFilter) => void;
}) {
  return (
    <>
      <label className="text-xs font-bold" style={{ color: "var(--dim)" }} htmlFor={id}>{T.common.category}</label>
      <select
        id={id}
        value={value === "all" ? "all" : value === "none" ? "none" : String(value)}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === "all" ? "all" : v === "none" ? "none" : Number(v));
        }}
        className="rounded-full px-3 py-1.5 text-sm font-bold"
        style={{ background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }}
      >
        <option value="all">{T.common.all}</option>
        {categoryTreeEntries(categories).map(({ cat, depth }) => (
          <option key={cat.id} value={String(cat.id)}>{categoryOptionLabel(cat, depth)}</option>
        ))}
        <option value="none">{T.common.uncategorized}</option>
      </select>
    </>
  );
}

/** セレクトの選択肢表示用の階段式ラベル（深さぶん全角スペースで字下げする）。 */
function categoryOptionLabel(cat: CategoryItem, depth: number): string {
  return depth > 0 ? `${"　".repeat(depth)}└ ${cat.name}` : cat.name;
}

/** カテゴリの管理シート（一覧側の全体メニューから開く）。追加・編集（名前と親カテゴリ）・削除を行う。 */
function CategoryManageSheet({ categories, onClose }: { categories: CategoryItem[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<CategoryItem | null>(null);
  const [editing, setEditing] = useState<CategoryItem | null>(null);
  const [editName, setEditName] = useState("");
  const [editParentId, setEditParentId] = useState<number | null>(null);
  const tree = categoryTreeEntries(categories);
  const nameById = new Map(categories.map((c) => [c.id, c.name]));
  const create = useMutation({
    mutationFn: async (v: { name: string; parent_id: number | null }) => await api.createCategory({ name: v.name, parent_id: v.parent_id }),
    onSuccess: () => {
      setName("");
      setParentId(null);
      setError("");
      queryClient.invalidateQueries({ queryKey: ["home"] });
    },
    onError: (e) => setError(errMsg(e, T.categoryManage.addFailed)),
  });
  const update = useMutation({
    mutationFn: async (v: { category_id: number; name: string; parent_id: number | null }) =>
      await api.updateCategory({ category_id: v.category_id, name: v.name, parent_id: v.parent_id }),
    onSuccess: () => {
      setEditing(null);
      setError("");
      queryClient.invalidateQueries({ queryKey: ["home"] });
    },
    onError: (e) => setError(errMsg(e, T.common.saveFailed)),
  });
  const del = useMutation({
    mutationFn: async (id: number) => await api.deleteCategory({ category_id: id }),
    onSuccess: () => {
      setConfirmDelete(null);
      queryClient.invalidateQueries({ queryKey: ["home"] });
    },
    onError: (e) => setError(errMsg(e, T.common.deleteFailed)),
  });
  const submit = () => {
    const v = name.trim();
    if (!v) { setError(T.categoryManage.nameRequired); return; }
    setError("");
    create.mutate({ name: v, parent_id: parentId });
  };
  const startEdit = (cat: CategoryItem) => {
    setEditing(cat);
    setEditName(cat.name);
    setEditParentId(cat.parent_id ?? null);
    setConfirmDelete(null);
    setError("");
  };
  const submitEdit = () => {
    if (!editing) return;
    const v = editName.trim();
    if (!v) { setError(T.categoryManage.nameRequired); return; }
    setError("");
    update.mutate({ category_id: editing.id, name: v, parent_id: editParentId });
  };
  // 編集中カテゴリの親の選択肢: 自分自身と自分の子孫は選べない（循環防止）。
  const editBlockedIds = editing ? categoryDescendantIdSet(categories, editing.id) : new Set<number>();
  const childCountOf = (id: number) => categories.filter((c) => c.parent_id === id).length;
  return (
    <div className="sheet-overlay fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(10,6,20,0.55)" }} role="dialog" aria-modal="true" aria-label={T.categoryManage.title}>
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded-3xl p-5" style={{ background: "var(--surface)" }}>
        <div className="flex items-start justify-between gap-3">
          <h2 className="font-display text-lg font-bold" style={{ color: "var(--text)" }}>{T.categoryManage.title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={T.categoryManage.closeAria}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-base"
            style={{ background: "var(--surface-alt)", color: "var(--dim)" }}
          >
            ×
          </button>
        </div>
        <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--dim)" }}>
          {T.categoryManage.description}
        </p>

        <label className="mt-4 block text-sm font-bold" style={{ color: "var(--text)" }} htmlFor="category-name">
          {T.categoryManage.newNameLabel}
        </label>
        <input
          id="category-name"
          {...FIELDS.createCategory.name}
          value={name}
          onChange={(e) => { setName(e.target.value); setError(""); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
          }}
          placeholder={T.categoryManage.namePlaceholder}
          className="mt-1 w-full rounded-2xl px-3 py-2.5"
          style={{ background: "var(--surface-alt)", color: "var(--text)", border: "1px solid var(--border)" }}
        />
        <label className="mt-3 block text-sm font-bold" style={{ color: "var(--text)" }} htmlFor="category-parent">
          {T.categoryManage.parentLabel}
        </label>
        <select
          id="category-parent"
          value={parentId === null ? "" : String(parentId)}
          onChange={(e) => setParentId(e.target.value === "" ? null : Number(e.target.value))}
          className="mt-1 w-full rounded-2xl px-3 py-2.5"
          style={{ background: "var(--surface-alt)", color: "var(--text)", border: "1px solid var(--border)" }}
        >
          <option value="">{T.categoryManage.topLevelOption}</option>
          {tree.map(({ cat, depth }) => (
            <option key={cat.id} value={String(cat.id)}>{categoryOptionLabel(cat, depth)}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={submit}
          disabled={create.isPending}
          className="mt-3 w-full rounded-full px-4 py-2.5 font-bold text-white disabled:opacity-50"
          style={{ background: "var(--accent)" }}
        >
          {create.isPending ? T.categoryManage.adding : T.categoryManage.add}
        </button>
        {error && <p className="mt-2 text-sm" style={{ color: "var(--danger)" }}>{error}</p>}

        <div className="mt-4 flex flex-col gap-2">
          {categories.length === 0 && (
            <p className="text-sm" style={{ color: "var(--dim)" }}>{T.categoryManage.empty}</p>
          )}
          {tree.map(({ cat, depth }) => (
            <div key={cat.id} style={{ marginLeft: depth * 20 }}>
              {editing?.id === cat.id ? (
                <div className="rounded-2xl px-3 py-3" style={{ background: "var(--surface-alt)" }}>
                  <label className="block text-xs font-bold" style={{ color: "var(--dim)" }} htmlFor={`category-edit-name-${cat.id}`}>
                    {T.categoryManage.nameLabel}
                  </label>
                  <input
                    id={`category-edit-name-${cat.id}`}
                    {...FIELDS.updateCategory.name}
                    value={editName}
                    onChange={(e) => { setEditName(e.target.value); setError(""); }}
                    className="mt-1 w-full rounded-xl px-3 py-2"
                    style={{ background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }}
                  />
                  <label className="mt-3 block text-xs font-bold" style={{ color: "var(--dim)" }} htmlFor={`category-edit-parent-${cat.id}`}>
                    {T.categoryManage.parentLabel}
                  </label>
                  <select
                    id={`category-edit-parent-${cat.id}`}
                    value={editParentId === null ? "" : String(editParentId)}
                    onChange={(e) => setEditParentId(e.target.value === "" ? null : Number(e.target.value))}
                    className="mt-1 w-full rounded-xl px-3 py-2"
                    style={{ background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }}
                  >
                    <option value="">{T.categoryManage.topLevelOption}</option>
                    {tree.filter(({ cat: c }) => !editBlockedIds.has(c.id)).map(({ cat: c, depth: d }) => (
                      <option key={c.id} value={String(c.id)}>{categoryOptionLabel(c, d)}</option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs" style={{ color: "var(--dim)" }}>{T.categoryManage.parentNote}</p>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={() => { setEditing(null); setError(""); }}
                      className="flex-1 rounded-full px-3 py-2 text-sm font-bold"
                      style={{ background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }}
                    >
                      {T.common.cancel}
                    </button>
                    <button
                      type="button"
                      onClick={submitEdit}
                      disabled={update.isPending}
                      className="flex-1 rounded-full px-3 py-2 text-sm font-bold text-white disabled:opacity-50"
                      style={{ background: "var(--accent)" }}
                    >
                      {update.isPending ? T.common.saving : T.common.save}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-2xl px-3 py-2" style={{ background: "var(--surface-alt)" }}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-bold" style={{ color: "var(--text)" }}>
                      {depth > 0 && <span aria-hidden="true" style={{ color: "var(--dim)" }}>└ </span>}
                      {cat.name}
                    </span>
                    <span className="block truncate text-xs" style={{ color: "var(--dim)" }}>
                      {T.categoryManage.parentDisplay(cat.parent_id != null ? (nameById.get(cat.parent_id) ?? T.categoryManage.unknownParent) : null)}
                    </span>
                  </span>
                  {confirmDelete?.id === cat.id ? (
                    <>
                      <span className="shrink-0 text-xs" style={{ color: "var(--danger)" }}>
                        {T.categoryManage.deleteConfirmPrefix}{childCountOf(cat.id) > 0 ? T.categoryManage.deleteChildMoveNote(cat.parent_id != null ? T.categoryManage.deleteDestNamed(nameById.get(cat.parent_id) ?? "") : T.categoryManage.deleteDestTop) : ""}
                      </span>
                      <button
                        type="button"
                        disabled={del.isPending}
                        onClick={() => del.mutate(cat.id)}
                        className="shrink-0 rounded-full px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
                        style={{ background: "var(--danger)" }}
                      >
                        {T.common.deleteConfirm}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(null)}
                        className="shrink-0 rounded-full px-3 py-1.5 text-xs font-bold"
                        style={{ background: "var(--surface)", color: "var(--text)" }}
                      >
                        {T.categoryManage.cancelDelete}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => startEdit(cat)}
                        aria-label={T.categoryManage.editAria(cat.name)}
                        className="shrink-0 rounded-full px-3 py-1.5 text-xs font-bold"
                        style={{ background: "var(--surface)", color: "var(--text)" }}
                      >
                        {T.common.edit}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setConfirmDelete(cat); setEditing(null); setError(""); }}
                        aria-label={T.categoryManage.deleteAria(cat.name)}
                        className="shrink-0 rounded-full px-3 py-1.5 text-xs font-bold"
                        style={{ background: "var(--surface)", color: "var(--danger)" }}
                      >
                        {T.common.delete}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** キャラへカテゴリを割り当てるシート（キャラの設定メニューから開く）。複数選択可。 */
function CategoryAssignSheet({
  character,
  categories,
  onClose,
}: {
  character: CharacterItem;
  categories: CategoryItem[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState("");
  const rawInitialIds: number[] = character.category_ids;
  // 初期表示も祖先除外ルールでそろえる（子と祖先が両方付いた古いデータは子だけ表示）。
  const initialIds: number[] = pruneAncestorCategoryIds(categories, rawInitialIds);
  const [selectedIds, setSelectedIds] = useState<number[]>(initialIds);
  const assign = useMutation({
    mutationFn: async (ids: number[]) => await api.setCharacterCategories({ character_id: character.id, category_ids: ids }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["home"] });
      onClose();
    },
    onError: (e) => setError(errMsg(e, T.categoryAssign.setFailed)),
  });
  const toggle = (id: number) => {
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      // 子カテゴリを付けたら、付いていた祖先カテゴリは自動で外す（v1.27）。
      const ancestors = categoryAncestorIdSet(categories, id);
      return [...prev.filter((x) => !ancestors.has(x)), id];
    });
    setError("");
  };
  // 選択中の子孫カテゴリがあるカテゴリ（祖先側）は選べない。
  const blockingChildName = (id: number): string | null => {
    for (const sid of selectedIds) {
      if (sid !== id && categoryAncestorIdSet(categories, sid).has(id)) {
        return categories.find((c) => c.id === sid)?.name ?? null;
      }
    }
    return null;
  };
  const isDirty = [...selectedIds].sort((a, b) => a - b).join(",") !== [...initialIds].sort((a, b) => a - b).join(",");
  return (
    <div className="sheet-overlay fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(10,6,20,0.55)" }} role="dialog" aria-modal="true" aria-label={T.categoryAssign.sheetAria(character.display_name)}>
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded-3xl p-5" style={{ background: "var(--surface)" }}>
        <div className="flex items-center gap-3">
          <Avatar imageUrl={character.image_url} name={character.display_name} themeColor={character.theme_color} size={40} />
          <h2 className="font-display min-w-0 flex-1 truncate text-lg font-bold" style={{ color: "var(--text)" }}>{T.categoryAssign.title(character.display_name)}</h2>
        </div>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--dim)" }}>
          {T.categoryAssign.description}
        </p>
        {categories.length === 0 && (
          <p className="mt-3 text-sm leading-relaxed" style={{ color: "var(--dim)" }}>
            {T.common.noCategoriesYet}
          </p>
        )}
        <div className="mt-4 flex flex-col gap-2" role="group" aria-label={T.common.categoryFilterGroupAria}>
          {categoryTreeEntries(categories).map(({ cat, depth }) => {
            const selected = selectedIds.includes(cat.id);
            // 子孫カテゴリが選択中なら、この祖先カテゴリは選択できない（v1.27）。
            const blockedBy = selected ? null : blockingChildName(cat.id);
            const disabled = blockedBy !== null;
            return (
              <label
                key={cat.id}
                className="flex items-center gap-3 rounded-2xl px-4 py-3"
                style={{
                  background: selected ? "var(--accent-soft)" : "var(--surface-alt)",
                  color: "var(--text)",
                  outline: selected ? "2px solid var(--accent)" : "none",
                  marginLeft: depth * 20,
                  cursor: disabled ? "not-allowed" : "pointer",
                  opacity: disabled ? 0.55 : 1,
                }}
              >
                <input
                  type="checkbox"
                  checked={selected}
                  disabled={disabled}
                  onChange={() => toggle(cat.id)}
                  aria-label={T.common.categoryAria(cat.name)}
                  className="h-5 w-5 shrink-0"
                  style={{ accentColor: "var(--accent)" }}
                />
                <span className="font-bold">
                  {depth > 0 && <span aria-hidden="true" style={{ color: "var(--dim)" }}>└ </span>}
                  {cat.name}
                </span>
                {selected && <span className="ml-auto text-xs font-bold" style={{ color: "var(--accent)" }}>{T.common.selected}</span>}
                {disabled && (
                  <span className="ml-auto text-right text-xs" style={{ color: "var(--dim)" }}>
                    {T.categoryAssign.blockedByChild(blockedBy ?? "")}
                  </span>
                )}
              </label>
            );
          })}
          {categories.length > 0 && selectedIds.length === 0 && (
            <p className="px-1 text-xs" style={{ color: "var(--dim)" }}>{T.categoryAssign.currentlyUncategorized}</p>
          )}
        </div>
        {error && <p className="mt-2 text-sm" style={{ color: "var(--danger)" }}>{error}</p>}
        <div className="mt-4 flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-full px-4 py-2.5 font-bold"
            style={{ background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }}
          >
            {T.common.cancel}
          </button>
          <button
            type="button"
            onClick={() => assign.mutate(selectedIds)}
            disabled={assign.isPending || !isDirty}
            className="flex-1 rounded-full px-4 py-2.5 font-bold text-white disabled:opacity-50"
            style={{ background: "var(--accent)" }}
          >
            {assign.isPending ? T.common.saving : T.common.save}
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ review (v1.5)

type ReviewHistoryData = ApiResponse<typeof api, "getReviewHistory">;

// 表示文は display-texts.ts に集約（設計書 v3.3）。失敗理由の解決は
// 返信側の failReasonLabel と共通の labelFrom を使う。
function reviewFailLabel(reason: string): string {
  return labelFrom(T.review.failReasons, reason, T.review.failWithDetail, T.review.failFallback);
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** レビューモードの切替ボタン。通常モードでは目立たないよう低コントラストで小さく表示する。 */
function ReviewModeToggle({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      className="shrink-0 rounded-full px-2.5 py-1 text-xs whitespace-nowrap"
      style={{
        background: active ? "var(--accent-soft)" : "transparent",
        color: "var(--dim)",
        border: "1px solid var(--border)",
        opacity: active ? 1 : 0.6,
      }}
    >
      {T.review.modeToggle(active)}
    </button>
  );
}

/** 選択した発言への指摘を書くパネル。 */
function ReviewPanel({
  speakerName,
  messageBody,
  busy,
  error,
  onSubmit,
  onCancel,
  onOpenHistory,
}: {
  speakerName: string;
  messageBody: string;
  busy: boolean;
  error: string;
  onSubmit: (feedback: string) => void;
  onCancel: () => void;
  onOpenHistory: () => void;
}) {
  const [feedback, setFeedback] = useState("");
  const [localError, setLocalError] = useState("");
  return (
    <div className="mb-2 rounded-2xl p-3" style={{ background: "var(--surface)", border: "1.5px solid var(--accent)" }} role="form" aria-label={T.review.panelAria}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-bold" style={{ color: "var(--dim)" }}>{T.review.targetLabel(speakerName)}</p>
        <button type="button" onClick={onCancel} aria-label={T.review.cancelSelectionAria} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm" style={{ background: "var(--surface-alt)", color: "var(--dim)" }}>
          ×
        </button>
      </div>
      <p className="mt-1 line-clamp-3 text-sm whitespace-pre-wrap" style={{ color: "var(--text)" }}>{messageBody}</p>
      <label className="mt-3 block text-sm font-bold" style={{ color: "var(--text)" }} htmlFor="review-feedback">
        {T.review.feedbackLabel}
      </label>
      <textarea
        id="review-feedback"
        {...FIELDS.submitReview.feedback}
        value={feedback}
        onChange={(e) => { setFeedback(e.target.value); setLocalError(""); }}
        rows={3}
        placeholder={T.review.feedbackPlaceholder}
        className="mt-1 w-full rounded-2xl p-3 text-sm"
        style={{ background: "var(--surface-alt)", color: "var(--text)", border: "1px solid var(--border)" }}
      />
      {(localError || error) && <p className="mt-1 text-sm" style={{ color: "var(--danger)" }}>{localError || error}</p>}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (!feedback.trim()) { setLocalError(T.review.feedbackRequired); return; }
            onSubmit(feedback.trim());
          }}
          className="rounded-full px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
          style={{ background: "var(--accent)" }}
        >
          {busy ? T.review.sending : T.review.submit}
        </button>
        <button type="button" onClick={onOpenHistory} className="rounded-full px-3 py-2 text-xs font-bold" style={{ background: "var(--surface-alt)", color: "var(--dim)" }}>
          {T.review.openHistoryForChar}
        </button>
      </div>
      <p className="mt-2 text-xs leading-relaxed" style={{ color: "var(--dim)" }}>
        {T.review.panelNote}
      </p>
    </div>
  );
}

/** 差分の変更前・変更後から、共通の前後を取り除いた「変わった部分」を抜き出す。
 *  背景本文のような長い値でも、実際に変わった箇所だけを前後の文脈つきで
 *  見せるためのもの（共通部分は先頭・末尾から最大50字だけ残す）。 */
function diffChangedSpans(before: string, after: string) {
  let p = 0;
  const maxP = Math.min(before.length, after.length);
  while (p < maxP && before[p] === after[p]) p++;
  let s = 0;
  const maxS = Math.min(before.length - p, after.length - p);
  while (s < maxS && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  const CTX = 50;
  const span = (text: string, start: number, end: number) => {
    const preFrom = Math.max(0, start - CTX);
    const postTo = Math.min(text.length, end + CTX);
    return {
      pre: text.slice(preFrom, start),
      mid: text.slice(start, end),
      post: text.slice(end, postTo),
      preCut: preFrom > 0,
      postCut: postTo < text.length,
    };
  };
  return { before: span(before, p, before.length - s), after: span(after, p, after.length - s) };
}

/** 差分1件の変更前・変更後表示。短い値は全文、長い値は「変わった部分」の
 *  抜粋（変更箇所をハイライト）を主表示にし、全文は開閉式で残す。 */
function DiffValuePair({ before, after }: { before: string; after: string }) {
  const long = before.length > 200 || after.length > 200;
  if (!long) {
    return (
      <>
        <p className="mt-1 max-h-40 overflow-y-auto text-xs whitespace-pre-wrap break-words" style={{ color: "var(--dim)" }}>
          <span className="font-bold">{T.reviewHistory.diffBefore}</span>{before}
        </p>
        <p className="mt-1 max-h-40 overflow-y-auto text-xs whitespace-pre-wrap break-words" style={{ color: "var(--text)" }}>
          <span className="font-bold">{T.reviewHistory.diffAfter}</span>{after}
        </p>
      </>
    );
  }
  const spans = diffChangedSpans(before, after);
  const renderSpan = (sp: { pre: string; mid: string; post: string; preCut: boolean; postCut: boolean }, markBg: string, emptyLabel: string) => (
    <>
      {sp.preCut ? "…" : ""}{sp.pre}
      <span style={{ background: markBg, borderRadius: 4, padding: "0 2px" }}>{sp.mid || emptyLabel}</span>
      {sp.post}{sp.postCut ? "…" : ""}
    </>
  );
  return (
    <>
      <p className="mt-1 text-xs font-bold" style={{ color: "var(--dim)" }}>{T.reviewHistory.diffChangedPart}</p>
      <p className="mt-0.5 text-xs whitespace-pre-wrap break-words" style={{ color: "var(--dim)" }}>
        <span className="font-bold">{T.reviewHistory.diffBefore}</span>
        {renderSpan(spans.before, "color-mix(in srgb, var(--danger) 22%, transparent)", "（なし）")}
      </p>
      <p className="mt-0.5 text-xs whitespace-pre-wrap break-words" style={{ color: "var(--text)" }}>
        <span className="font-bold">{T.reviewHistory.diffAfter}</span>
        {renderSpan(spans.after, "var(--accent-soft)", "（削除）")}
      </p>
      <details className="mt-1.5">
        <summary className="cursor-pointer text-xs font-bold" style={{ color: "var(--dim)" }}>{T.reviewHistory.diffFullSummary}</summary>
        <p className="mt-1 max-h-40 overflow-y-auto text-xs whitespace-pre-wrap break-words" style={{ color: "var(--dim)" }}>
          <span className="font-bold">{T.reviewHistory.diffBefore}</span>{before}
        </p>
        <p className="mt-1 max-h-40 overflow-y-auto text-xs whitespace-pre-wrap break-words" style={{ color: "var(--text)" }}>
          <span className="font-bold">{T.reviewHistory.diffAfter}</span>{after}
        </p>
      </details>
    </>
  );
}

/** キャラごとのレビュー履歴シート。差分・再出力JSON・取り消しを含む。 */
function ReviewHistorySheet({ characterId, characterName, onClose }: { characterId: number; characterName: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const history = useQuery({
    queryKey: ["reviewHistory", characterId],
    queryFn: () => api.getReviewHistory({ character_id: characterId }),
    refetchInterval: 10000,
  });
  const [confirmRevertId, setConfirmRevertId] = useState<number | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [revertError, setRevertError] = useState("");
  const revert = useMutation({
    mutationFn: async (revisionId: number) => await api.revertRevision({ revision_id: revisionId }),
    onSuccess: () => {
      setConfirmRevertId(null);
      setRevertError("");
      queryClient.invalidateQueries({ queryKey: ["reviewHistory", characterId] });
      queryClient.invalidateQueries({ queryKey: ["home"] });
      queryClient.invalidateQueries({ queryKey: ["chat"] });
      queryClient.invalidateQueries({ queryKey: ["group"] });
    },
    onError: (e) => setRevertError(errMsg(e, T.reviewHistory.revertFailed)),
  });
  const copyJson = async (reviewId: number, json: string) => {
    try {
      await navigator.clipboard.writeText(json);
      setCopiedId(reviewId);
    } catch {
      setCopiedId(null);
    }
  };

  const reviews: ReviewHistoryData["reviews"] = history.data?.reviews ?? [];
  return (
    <div className="sheet-overlay fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(10,6,20,0.55)" }} role="dialog" aria-modal="true" aria-label={T.reviewHistory.title(characterName)}>
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded-3xl p-5" style={{ background: "var(--surface)" }}>
        <div className="flex items-start justify-between gap-2">
          <h2 className="font-display text-lg font-bold" style={{ color: "var(--text)" }}>{T.reviewHistory.title(characterName)}</h2>
          <button type="button" onClick={onClose} aria-label={T.reviewHistory.closeAria} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full" style={{ background: "var(--surface-alt)", color: "var(--dim)" }}>
            ×
          </button>
        </div>
        <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--dim)" }}>
          {T.reviewHistory.description}
        </p>
        {history.isPending && <p className="mt-4 text-sm" style={{ color: "var(--dim)" }}>{T.common.loading}</p>}
        {history.error && <p className="mt-4 text-sm" style={{ color: "var(--danger)" }}>{T.common.loadFailed}</p>}
        {history.data && reviews.length === 0 && (
          <p className="mt-4 text-sm" style={{ color: "var(--dim)" }}>{T.reviewHistory.empty}</p>
        )}
        {revertError && <p className="mt-3 text-sm" style={{ color: "var(--danger)" }}>{revertError}</p>}
        <div className="mt-4 flex flex-col gap-4">
          {reviews.map((r) => (
            <article key={r.id} className="rounded-2xl p-3" style={{ background: "var(--surface-alt)" }} aria-label={T.reviewHistory.articleAria(formatDateTime(r.created_at))}>
              <div className="flex items-center gap-2">
                <span
                  className="rounded-full px-2 py-0.5 text-xs font-bold"
                  style={{
                    background: "var(--surface)",
                    color: r.status === "failed" ? "var(--danger)" : r.status === "done" ? "var(--gold)" : "var(--dim)",
                  }}
                >
                  {T.review.statusLabels[r.status] ?? r.status}
                </span>
                <span className="text-xs" style={{ color: "var(--dim)" }}>{formatDateTime(r.created_at)}・{r.target_kind === "group" ? T.reviewHistory.groupMessage : r.target_kind === "settings" ? T.reviewHistory.settingsMessage : T.reviewHistory.chatMessage}</span>
                {r.review_kind === "auto" && (
                  <span className="rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: "var(--surface)", color: "var(--gold)" }}>{T.reviewHistory.autoBadge}</span>
                )}
                {r.revision?.reverted_at && (
                  <span className="rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: "var(--surface)", color: "var(--danger)" }}>{T.reviewHistory.revertedBadge}</span>
                )}
              </div>
              <p className="mt-2 text-xs font-bold" style={{ color: "var(--dim)" }}>{r.review_kind === "auto" ? T.reviewHistory.autoTargetHeading : T.reviewHistory.targetHeading}</p>
              <p className="mt-0.5 line-clamp-4 text-sm whitespace-pre-wrap" style={{ color: "var(--text)" }}>{r.review_kind === "auto" ? r.batch_text : r.target_kind === "settings" ? T.reviewHistory.settingsTargetBody : r.message_body}</p>
              <p className="mt-2 text-xs font-bold" style={{ color: "var(--dim)" }}>{r.review_kind === "auto" ? T.reviewHistory.autoFeedbackHeading : T.reviewHistory.feedbackHeading}</p>
              <p className="mt-0.5 text-sm whitespace-pre-wrap" style={{ color: "var(--text)" }}>{r.feedback}</p>
              {r.status === "failed" && (
                <>
                  <p className="mt-2 text-sm" style={{ color: "var(--danger)" }}>{reviewFailLabel(r.fail_reason)}{T.reviewHistory.failedNoteSuffix}</p>
                  {r.fail_detail ? (
                    <p className="mt-1 text-xs whitespace-pre-wrap break-words" style={{ color: "var(--dim)" }}>{T.reviewHistory.failDetailLabel(r.fail_detail)}</p>
                  ) : null}
                </>
              )}
              {r.status === "no_change" && (
                <p className="mt-2 text-sm" style={{ color: "var(--dim)" }}>{T.reviewHistory.noChangeNote}</p>
              )}
              {r.intent.trim() && (
                <>
                  <p className="mt-3 text-xs font-bold" style={{ color: "var(--dim)" }}>{T.reviewHistory.intentHeading}</p>
                  <p className="mt-0.5 text-sm whitespace-pre-wrap" style={{ color: "var(--text)" }}>{r.intent}</p>
                </>
              )}
              {r.revision && (
                <>
                  <p className="mt-3 text-xs font-bold" style={{ color: "var(--dim)" }}>{T.reviewHistory.diffHeading(r.revision.diff.length)}</p>
                  <div className="mt-1 flex flex-col gap-2">
                    {r.revision.diff.map((d, i) => (
                      <div key={i} className="rounded-xl p-2.5" style={{ background: "var(--surface)" }}>
                        <p className="text-xs font-bold break-all" style={{ color: "var(--gold)" }}>{d.path}</p>
                        <DiffValuePair before={d.before} after={d.after} />
                      </div>
                    ))}
                  </div>
                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs font-bold" style={{ color: "var(--dim)" }}>{T.reviewHistory.beforeJsonSummary}</summary>
                    <pre className="mt-2 max-h-64 overflow-auto rounded-xl p-3 text-xs whitespace-pre-wrap break-all" style={{ background: "var(--surface)", color: "var(--text)" }}>{r.revision.before_json}</pre>
                  </details>
                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs font-bold" style={{ color: "var(--dim)" }}>{T.reviewHistory.fullJsonSummary}</summary>
                    <pre className="mt-2 max-h-64 overflow-auto rounded-xl p-3 text-xs whitespace-pre-wrap break-all" style={{ background: "var(--surface)", color: "var(--text)" }}>{r.revision.after_json}</pre>
                    <button
                      type="button"
                      onClick={() => copyJson(r.id, r.revision!.after_json)}
                      className="mt-2 rounded-full px-3 py-1.5 text-xs font-bold"
                      style={{ background: "var(--surface)", color: "var(--text)" }}
                    >
                      {copiedId === r.id ? T.reviewHistory.copied : T.reviewHistory.copyJson}
                    </button>
                  </details>
                  {!r.revision.reverted_at && (
                    confirmRevertId === r.revision.id ? (
                      <div className="mt-3 rounded-xl p-3" style={{ background: "var(--surface)" }}>
                        <p className="text-sm" style={{ color: "var(--text)" }}>{T.reviewHistory.revertConfirm}</p>
                        <div className="mt-2 flex gap-2">
                          <button type="button" onClick={() => setConfirmRevertId(null)} className="flex-1 rounded-full px-3 py-2 text-sm font-bold" style={{ background: "var(--surface-alt)", color: "var(--text)" }}>
                            {T.reviewHistory.revertCancel}
                          </button>
                          <button
                            type="button"
                            disabled={revert.isPending}
                            onClick={() => revert.mutate(r.revision!.id)}
                            className="flex-1 rounded-full px-3 py-2 text-sm font-bold text-white disabled:opacity-50"
                            style={{ background: "var(--danger)" }}
                          >
                            {T.reviewHistory.revertDo}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => { setConfirmRevertId(r.revision!.id); setRevertError(""); }}
                        className="mt-3 rounded-full px-3 py-1.5 text-xs font-bold"
                        style={{ background: "var(--surface)", color: "var(--danger)" }}
                      >
                        {T.reviewHistory.revertButton}
                      </button>
                    )
                  )}
                  {r.revision.reverted_at && (
                    <p className="mt-2 text-xs" style={{ color: "var(--dim)" }}>{T.reviewHistory.revertedNote(formatDateTime(r.revision.reverted_at))}</p>
                  )}
                </>
              )}
              {r.review_kind === "auto" && (
                <ReviewPromptResponse prompt={r.prompt_text} response={r.response_text} />
              )}
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ home

type CharSort = "added" | "gojuon" | "recent";

// 並び替え・簡易表示の選択の保持は「サーバ保存値（meta）＋セッション内
// （モジュールスコープ）ストア」に一本化した（冗長性レビュー B-7: 以前は
// useState／モジュール変数／localStorage／サーバ値／React Query キャッシュ
// への setQueryData の5系統で保持していた）。localStorage は埋め込み表示で
// 保持されず実質的に初期値しか返さなかったため、その読み書きを撤去しても
// 表示の挙動は変わらない。セッション内ストアは、画面遷移で HomeView が
// アンマウントされても選択が失われず、一覧へ戻った時に即座にその並びで
// 表示するために残す（設計書 v1.8 / 4.8章）。永続化の正はサーバ値で、
// 一覧データ取得後に（この画面で変更していなければ）反映される。
let sessionSort: CharSort | null = null;
let sessionCompact: boolean | null = null;

// グループ一覧のページ位置（10件/ページ、設計書 v2.0 / A）。画面遷移で失われないようセッション内に保持する。
let sessionGroupPage = 0;

// 一覧上部のタブ（個人 / グループ）。選択中タブのチャットだけを一覧に表示する。
// 画面遷移で失われないようセッション内に保持する。
let sessionHomeTab: "personal" | "group" = "personal";

/** キャラが属するカテゴリID一覧（正はサーバが返す category_ids のみ。旧カラム由来のフォールバックは撤去済み）。 */
function charCategoryIds(c: CharacterItem): number[] {
  return c.category_ids;
}

/** 選択中の並び替えでキャラ配列を並べ替える（一覧とグループ作成で共用）。 */
function sortCharactersBy(list: CharacterItem[], sort: CharSort): CharacterItem[] {
  return [...list].sort((a, b) => {
    if (sort === "gojuon") {
      const byName = a.display_name.localeCompare(b.display_name, "ja");
      return byName !== 0 ? byName : a.id - b.id;
    }
    if (sort === "recent") {
      // 会話のあるキャラを最終発言時刻の新しい順に。会話が無いキャラは追加順で後ろ。
      if (a.last_activity_at && b.last_activity_at) {
        const byTime = b.last_activity_at.localeCompare(a.last_activity_at);
        return byTime !== 0 ? byTime : a.id - b.id;
      }
      if (a.last_activity_at) return -1;
      if (b.last_activity_at) return 1;
      return a.id - b.id;
    }
    return a.id - b.id; // 追加順（サーバも id 昇順で返す）
  });
}

/** グループ一覧の各行から開く小さなメニュー（ローカル改善: 上流リポジトリには無い）。
 * 控えめなボトムシートで、赤字の「削除」だけを置く。実際の削除は呼び出し側が
 * 既存の確認ダイアログを挟んでから deleteGroup を呼ぶ。 */
function GroupListMenuSheet({
  group,
  onClose,
  onDelete,
}: {
  group: GroupItem;
  onClose: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="sheet-overlay fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(10,6,20,0.55)" }} role="dialog" aria-modal="true" aria-label={T.home.groupMenuAria(group.name)}>
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded-3xl p-5" style={{ background: "var(--surface)" }}>
        <h2 className="font-display min-w-0 truncate text-lg font-bold" style={{ color: "var(--text)" }}>{T.home.groupMenuTitle(group.name)}</h2>
        <div className="mt-4 flex flex-col gap-2">
          <button
            type="button"
            onClick={onDelete}
            className="w-full rounded-2xl px-4 py-3 text-left"
            style={{ background: "var(--surface-alt)", color: "var(--text)" }}
          >
            <span className="block font-bold" style={{ color: "var(--danger)" }}>{T.home.groupDelete}</span>
            <span className="mt-0.5 block text-xs" style={{ color: "var(--dim)" }}>{T.home.groupDeleteDesc}</span>
          </button>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="mt-4 w-full rounded-full px-4 py-2.5 font-bold"
          style={{ background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }}
        >
          {T.common.close}
        </button>
      </div>
    </div>
  );
}

/** ファイルのダウンロード（このアプリが生成した内容をブラウザへ保存する）。 */
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const ZIP_CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function zipCrc32(data: Uint8Array): number {
  let crc = -1;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ ZIP_CRC_TABLE[(crc ^ data[i]!) & 0xff]!;
  }
  return (crc ^ -1) >>> 0;
}

/** 無圧縮（stored）で zip を組み立てる。キャラ情報の出力（JSON＋画像）専用。 */
function buildZipBlob(entries: { name: string; data: Uint8Array }[]): Blob {
  const enc = new TextEncoder();
  const chunks: BlobPart[] = [];
  const central: BlobPart[] = [];
  let offset = 0;
  let centralSize = 0;
  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = zipCrc32(e.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, e.data.length, true);
    local.setUint32(22, e.data.length, true);
    local.setUint16(26, nameBytes.length, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, e.data as BlobPart);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, 0, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, e.data.length, true);
    cen.setUint32(24, e.data.length, true);
    cen.setUint16(28, nameBytes.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), nameBytes);
    centralSize += 46 + nameBytes.length;
    offset += 30 + nameBytes.length + e.data.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
}

/** フォルダ名に使えない文字を除いた表示名（同名が重なったら呼び出し側で連番を付ける）。 */
function exportFolderName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, "_").trim();
  return cleaned || "character";
}

function imageExtFromMime(mime: string): string {
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  return "jpg";
}

/** 個人タブの「その他」メニュー。項目は今後ここへ追加していく。 */
function OtherMenuSheet({ onClose, onExportCharacters, onCategoryManage }: { onClose: () => void; onExportCharacters: () => void; onCategoryManage: () => void }) {
  const items: { label: string; description: string; onSelect: () => void }[] = [
    { label: T.home.exportCharacters, description: T.home.exportCharactersDesc, onSelect: onExportCharacters },
    { label: T.categoryManage.title, description: T.home.categoryManageDesc, onSelect: onCategoryManage },
  ];
  return (
    <div className="sheet-overlay fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(10,6,20,0.55)" }} role="dialog" aria-modal="true" aria-label={T.home.otherMenuAria}>
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded-3xl p-5" style={{ background: "var(--surface)" }}>
        <h2 className="font-display text-lg font-bold" style={{ color: "var(--text)" }}>{T.home.otherMenuTitle}</h2>
        <div className="mt-4 flex flex-col gap-2">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={item.onSelect}
              className="w-full rounded-2xl px-4 py-3 text-left"
              style={{ background: "var(--surface-alt)", color: "var(--text)" }}
            >
              <span className="block font-bold">{item.label}</span>
              <span className="mt-0.5 block text-xs" style={{ color: "var(--dim)" }}>{item.description}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="mt-4 w-full rounded-full px-4 py-2.5 font-bold"
          style={{ background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }}
        >
          {T.common.close}
        </button>
      </div>
    </div>
  );
}

/** キャラ情報の出力シート。キャラを複数選択でき、「画像も書き出す」を
 * オンにすると各キャラのフォルダへ character.json と画像ファイルが入る。
 * 1人・画像なしの時だけ character.json 単体で、その他は zip で出力する。
 * 一覧の並びは個人チャット一覧で現在設定されている並び方（sort）に一致させ、
 * 他のキャラ選択画面と同じカテゴリ絞り込みも持つ。絞り込みで隠れたキャラの
 * 選択状態は保持する（selected は表示対象とは独立に保持される）。 */
function CharacterExportSheet({ characters, categories, sort, onClose }: { characters: CharacterItem[]; categories: CategoryItem[]; sort: CharSort; onClose: () => void }) {
  const [selected, setSelected] = useState<number[]>([]);
  const [includeImages, setIncludeImages] = useState(false);
  const [error, setError] = useState("");
  const [catFilter, setCatFilter] = useState<CategoryFilter>("all");
  const visibleCharacters = sortCharactersBy(
    characters.filter((c) => charMatchesFilter(c, categories, catFilter)),
    sort,
  );
  const toggle = (id: number) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const runExport = useMutation({
    mutationFn: async () => {
      const res = await api.exportCharactersData({ character_ids: selected });
      const enc = new TextEncoder();
      const byId = new Map(characters.map((c) => [c.id, c]));
      // 1人だけ・画像なしなら character.json をそのままダウンロードする。
      if (res.items.length === 1 && !includeImages) {
        downloadBlob(new Blob([res.items[0]!.json], { type: "application/json" }), "character.json");
        return;
      }
      const usedFolders = new Set<string>();
      const entries: { name: string; data: Uint8Array }[] = [];
      for (const item of res.items) {
        const base = exportFolderName(item.display_name);
        let folder = base;
        for (let n = 2; usedFolders.has(folder); n++) folder = `${base} (${n})`;
        usedFolders.add(folder);
        entries.push({ name: `${folder}/character.json`, data: enc.encode(item.json) });
        const ch = byId.get(item.character_id);
        if (includeImages && ch?.image_url) {
          try {
            const r = await fetch(ch.image_url);
            if (r.ok) {
              const buf = new Uint8Array(await r.arrayBuffer());
              const ext = imageExtFromMime(r.headers.get("content-type") ?? "");
              entries.push({ name: `${folder}/character.${ext}`, data: buf });
            }
          } catch {
            // 画像が取得できないキャラは JSON だけを入れる。
          }
        }
      }
      downloadBlob(buildZipBlob(entries), "characters.zip");
    },
    onSuccess: () => {
      setError("");
      onClose();
    },
    onError: (e) => setError(errMsg(e, T.characterExport.failed)),
  });
  return (
    <div className="sheet-overlay fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(10,6,20,0.55)" }} role="dialog" aria-modal="true" aria-label={T.characterExport.title}>
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded-3xl p-5" style={{ background: "var(--surface)" }}>
        <div className="flex items-start justify-between gap-3">
          <h2 className="font-display text-lg font-bold" style={{ color: "var(--text)" }}>{T.characterExport.title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={T.common.close}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-base"
            style={{ background: "var(--surface-alt)", color: "var(--dim)" }}
          >
            ×
          </button>
        </div>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--dim)" }}>
          {T.characterExport.description}
        </p>
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSelected((prev) => [...new Set([...prev, ...visibleCharacters.map((c) => c.id)])])}
            className="rounded-full px-3 py-1.5 text-sm font-bold"
            style={{ background: "var(--surface-alt)", color: "var(--text)" }}
          >
            {T.characterExport.selectAll}
          </button>
          <button
            type="button"
            onClick={() => setSelected([])}
            className="rounded-full px-3 py-1.5 text-sm font-bold"
            style={{ background: "var(--surface-alt)", color: "var(--text)" }}
          >
            {T.characterExport.clearAll}
          </button>
          <span className="text-xs" style={{ color: "var(--dim)" }}>{T.common.selectedCount(selected.length)}</span>
        </div>
        {categories.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <CategoryFilterSelect id="char-export-category-filter" categories={categories} value={catFilter} onChange={setCatFilter} />
          </div>
        )}
        <div className="mt-2 flex flex-col gap-1">
          {visibleCharacters.map((c) => (
            <label key={c.id} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-2xl px-2 py-1.5" style={{ background: selected.includes(c.id) ? "var(--accent-soft)" : "transparent" }}>
              <input
                type="checkbox"
                checked={selected.includes(c.id)}
                onChange={() => toggle(c.id)}
                aria-label={T.characterExport.selectAria(c.display_name)}
                className="h-5 w-5 shrink-0"
              />
              <Avatar imageUrl={c.image_url} name={c.display_name} themeColor={c.theme_color} size={36} />
              <span className="font-bold" style={{ color: "var(--text)" }}>{c.display_name}</span>
              {!c.image_url && (
                <span className="text-xs" style={{ color: "var(--dim)" }}>{T.characterExport.noImageNote}</span>
              )}
            </label>
          ))}
          {visibleCharacters.length === 0 && (
            <p className="px-2 py-3 text-sm" style={{ color: "var(--dim)" }}>{T.common.categoryEmpty}</p>
          )}
        </div>
        <label className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-2xl px-3 py-2.5" style={{ background: "var(--surface-alt)" }}>
          <input
            type="checkbox"
            checked={includeImages}
            onChange={(e) => setIncludeImages(e.target.checked)}
            aria-label={T.characterExport.includeImages}
            className="mt-0.5 h-5 w-5 shrink-0"
          />
          <span>
            <span className="block text-sm font-bold" style={{ color: "var(--text)" }}>{T.characterExport.includeImages}</span>
            <span className="mt-0.5 block text-xs leading-relaxed" style={{ color: "var(--dim)" }}>{T.characterExport.includeImagesDesc}</span>
          </span>
        </label>
        {error && <p className="mt-2 text-sm" style={{ color: "var(--danger)" }}>{error}</p>}
        <div className="mt-4 flex gap-3">
          <button type="button" onClick={onClose} className="flex-1 rounded-full px-4 py-2.5 font-bold" style={{ background: "var(--surface-alt)", color: "var(--text)" }}>
            {T.common.cancel}
          </button>
          <button
            type="button"
            disabled={runExport.isPending}
            onClick={() => {
              if (selected.length < 1) { setError(T.characterExport.selectRequired); return; }
              setError("");
              runExport.mutate();
            }}
            className="flex-1 rounded-full px-4 py-2.5 font-bold text-white disabled:opacity-50"
            style={{ background: "var(--accent)" }}
          >
            {runExport.isPending ? T.characterExport.preparing : T.characterExport.exportButton(selected.length)}
          </button>
        </div>
      </div>
    </div>
  );
}

function HomeView({ go }: { go: (v: View) => void }) {
  const queryClient = useQueryClient();
  const home = useQuery({ queryKey: ["home"], queryFn: () => api.listHome({}), refetchInterval: 20000 });
  const [showImport, setShowImport] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showOtherMenu, setShowOtherMenu] = useState(false);
  const [showCharExport, setShowCharExport] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [confirmDeleteChar, setConfirmDeleteChar] = useState<CharacterItem | null>(null);
  const [menuGroup, setMenuGroup] = useState<GroupItem | null>(null);
  const [confirmDeleteGroup, setConfirmDeleteGroup] = useState<GroupItem | null>(null);
  const [deleteGroupError, setDeleteGroupError] = useState("");
  const [imageEditChar, setImageEditChar] = useState<CharacterItem | null>(null);
  const [menuChar, setMenuChar] = useState<CharacterItem | null>(null);
  const [editSettingsChar, setEditSettingsChar] = useState<CharacterItem | null>(null);
  const [renameChar, setRenameChar] = useState<CharacterItem | null>(null);
  const [categoryAssignChar, setCategoryAssignChar] = useState<CharacterItem | null>(null);
  const [autoTopicChar, setAutoTopicChar] = useState<CharacterItem | null>(null);
  const [showCategoryManage, setShowCategoryManage] = useState(false);
  // カテゴリ絞り込み: "all" = 全て表示 / "none" = 未分類のみ / 数値 = そのカテゴリのみ。
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  // キャラ名検索: 入力がある間だけ、名前に入力文字列を含むキャラに絞る。
  // カテゴリ絞り込み・並び替えと併用する（displayedCharacters の算出で重ねる）。
  const [searchQuery, setSearchQuery] = useState("");
  const [sort, setSort] = useState<CharSort>(() => sessionSort ?? "added");
  const [compact, setCompact] = useState<boolean>(() => sessionCompact ?? false);
  // 一覧上部のタブ: 個人（キャラとの1対1）/ グループ。選んだ方のチャットだけ表示する。
  const [homeTab, setHomeTab] = useState<"personal" | "group">(sessionHomeTab);
  const changeHomeTab = (t: "personal" | "group") => {
    sessionHomeTab = t;
    setHomeTab(t);
  };
  // グループ一覧のページ（10件/ページ、設計書 v2.0 / A）。
  const [groupPage, setGroupPage] = useState(sessionGroupPage);
  const changeGroupPage = (p: number) => {
    sessionGroupPage = p;
    setGroupPage(p);
  };
  // スケジューリング（設計書 v2.0 / B）: 一覧と編集シート。
  const schedulesQuery = useQuery({ queryKey: ["schedules"], queryFn: () => api.listSchedules({}), refetchInterval: 30000 });
  const [scheduleSheet, setScheduleSheet] = useState<{ mode: "create" } | { mode: "edit"; schedule: ScheduleItem } | null>(null);
  // 全体設定（v2.1）: 返信が届いたらClaudeへ通知する ON/OFF。サーバ側（meta）に保存する。
  // 返信を考えるAI（v3.5）: reply_engine（claude / muse）と、claude の時の
  // モデル claude_model も同じ全体設定に含まれる。全項目をまとめて送る。
  const globalSettings = useQuery({ queryKey: ["global-settings"], queryFn: () => api.getGlobalSettings({}) });
  const saveGlobalSettings = useMutation({
    mutationFn: async (v: { notify_reply: boolean; reply_engine: "claude" | "muse"; claude_model: "sonnet" | "opus" | "haiku" | "auto" }) =>
      await api.saveGlobalSettings(v),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["global-settings"] }),
  });
  const settingsNotify = globalSettings.data?.notify_reply ?? false;
  const settingsEngine = globalSettings.data?.reply_engine ?? "muse";
  const settingsModel = globalSettings.data?.claude_model ?? "sonnet";
  const saveSettings = (patch: Partial<{ notify_reply: boolean; reply_engine: "claude" | "muse"; claude_model: "sonnet" | "opus" | "haiku" | "auto" }>) =>
    saveGlobalSettings.mutate({ notify_reply: settingsNotify, reply_engine: settingsEngine, claude_model: settingsModel, ...patch });

  // 並び替え・簡易表示の選択はサーバ側（meta）に保存し、次回開いた時に復元する
  // （永続化の正はサーバ値。B-7 で localStorage の読み書きは撤去した）。
  // 利用者がこの画面で変更した後は、サーバ値で上書きしない（prefsTouchedRef）。
  // 変更時はセッション内ストアと一覧キャッシュにも即時反映し、チャット画面へ
  // 遷移して戻った時も手動更新なしで選択中の並び順で表示されるようにする
  // （設計書 v1.8 / 4.8章）。
  const prefsTouchedRef = useRef(sessionSort !== null || sessionCompact !== null);
  const savePrefs = useMutation({
    mutationFn: async (p: { char_sort: CharSort; char_compact: boolean }) => await api.saveListPrefs(p),
  });
  const serverSort = home.data?.char_sort;
  const serverCompact = home.data?.char_compact;
  useEffect(() => {
    if (prefsTouchedRef.current || serverSort === undefined || serverCompact === undefined) return;
    sessionSort = serverSort;
    sessionCompact = serverCompact;
    setSort(serverSort);
    setCompact(serverCompact);
  }, [serverSort, serverCompact]);

  const changeSort = (v: CharSort) => {
    prefsTouchedRef.current = true;
    sessionSort = v;
    setSort(v);
    // 一覧キャッシュにも即時反映する（戻ってきた時に古い値で上書きされないように）。
    queryClient.setQueryData<Home>(["home"], (old) => (old ? { ...old, char_sort: v } : old));
    savePrefs.mutate({ char_sort: v, char_compact: compact });
  };
  const changeCompact = (v: boolean) => {
    prefsTouchedRef.current = true;
    sessionCompact = v;
    setCompact(v);
    queryClient.setQueryData<Home>(["home"], (old) => (old ? { ...old, char_compact: v } : old));
    savePrefs.mutate({ char_sort: sort, char_compact: v });
  };

  // 会話を開く時は、一覧キャッシュの未読をその場で0にしてから遷移する。
  // サーバ側の既読化は会話画面の状態取得でも行われるが、一覧へ戻った時に
  // キャッシュの古い未読件数が残ってバッジが消えない事象への対策として、
  // 遷移時点で楽観的に消し、裏で再取得してサーバ値と一致させる。
  const openView = (v: View) => {
    if (v.kind === "chat") {
      queryClient.setQueryData<Home>(["home"], (old) =>
        old ? { ...old, characters: old.characters.map((c) => (c.id === v.characterId ? { ...c, unread_count: 0 } : c)) } : old,
      );
    } else if (v.kind === "group") {
      queryClient.setQueryData<Home>(["home"], (old) =>
        old ? { ...old, groups: old.groups.map((g) => (g.id === v.groupId ? { ...g, unread_count: 0 } : g)) } : old,
      );
    }
    go(v);
  };

  const deleteChar = useMutation({
    mutationFn: async (id: number) => await api.deleteCharacter({ character_id: id }),
    onSuccess: () => {
      setConfirmDeleteChar(null);
      queryClient.invalidateQueries({ queryKey: ["home"] });
    },
  });
  // グループ一覧からの削除（ローカル改善: 上流リポジトリには無い）。
  // 実処理は既存の deleteGroup を使う。生成中などサーバ側の制約で削除できない
  // 場合は、そのエラーを確認ダイアログの下ではなく一覧付近に表示して分かるようにする。
  const deleteGroupFromList = useMutation({
    mutationFn: async (id: number) => await api.deleteGroup({ group_id: id }),
    onSuccess: () => {
      setConfirmDeleteGroup(null);
      setMenuGroup(null);
      setDeleteGroupError("");
      queryClient.invalidateQueries({ queryKey: ["home"] });
      queryClient.invalidateQueries({ queryKey: ["schedules"] });
    },
    onError: (e) => {
      setConfirmDeleteGroup(null);
      setDeleteGroupError(errMsg(e, T.home.groupDeleteFailed));
    },
  });
  // グループの「今すぐランダム作成」（ローカル改善#7改訂: 上流リポジトリには無い）。
  // 抽選・人数決定・ゲスト/モブ/ナレーションのフラグ・自動命名はサーバ側の
  // 共通経路（スケジュールの新規チャット型と同じ createRandomGroup）に任せ、
  // クライアント側では抽選しない。作成のみで生成は開始しない。
  // 成功したらそのグループ画面へ遷移する。
  const [autoCreateError, setAutoCreateError] = useState("");
  const autoCreateGroup = useMutation({
    mutationFn: async () => await api.createRandomGroupNow({}),
    onSuccess: (r) => {
      setAutoCreateError("");
      queryClient.invalidateQueries({ queryKey: ["home"] });
      openView({ kind: "group", groupId: r.id, unreadFromSeq: null });
    },
    onError: (e) => setAutoCreateError(errMsg(e, T.home.groupCreateFailed)),
  });
  // 「スケジュールで自動作成」ボタン: 同じグループタブ内にあるスケジュール
  // 管理セクションへのスクロール先。
  const scheduleSectionRef = useRef<HTMLDivElement>(null);
  const { importKick, importStatus, now: importNow } = useImportStatus();
  const [importBannerDismissedFor, setImportBannerDismissedFor] = useState<string | null>(null);
  const importFinishedKey = importStatus.data?.finished_at ?? null;
  if (home.isPending) {
    return <p className="px-4 py-12 text-center text-sm" style={{ color: "var(--dim)" }}>{T.common.loading}</p>;
  }
  if (home.error) {
    return (
      <div className="px-4 py-12 text-center">
        <p className="text-sm" style={{ color: "var(--danger)" }}>{T.common.loadFailed}</p>
        <button type="button" onClick={() => home.refetch()} className="mt-3 rounded-full px-5 py-2 font-bold" style={{ background: "var(--surface-alt)", color: "var(--text)" }}>
          {T.common.reload}
        </button>
      </div>
    );
  }
  const { characters, groups, categories } = home.data;
  const categoryNameById = new Map(categories.map((c) => [c.id, c.name]));

  // グループ一覧は更新された順（最終発言時刻の降順。自動生成分も含む）に並べ、
  // 10件ごとにページ分けする（設計書 v2.0 / A）。個人一覧は従来通り。
  const GROUP_PAGE_SIZE = 10;
  const sortedGroups = [...groups].sort((a, b) =>
    b.last_activity_at !== a.last_activity_at
      ? b.last_activity_at.localeCompare(a.last_activity_at)
      : a.id - b.id,
  );
  const groupPageCount = Math.max(1, Math.ceil(sortedGroups.length / GROUP_PAGE_SIZE));
  const safeGroupPage = Math.min(groupPage, groupPageCount - 1);
  const pageGroups = sortedGroups.slice(safeGroupPage * GROUP_PAGE_SIZE, safeGroupPage * GROUP_PAGE_SIZE + GROUP_PAGE_SIZE);

  // カテゴリ絞り込み＋並び替えを適用した表示用リスト（v1.25、階層対応 v1.26）。
  // カテゴリは複数設定できるため、絞り込みは「そのカテゴリ（子孫カテゴリを含む）に
  // 属するか」で判定する（charMatchesCategory）。親カテゴリを選ぶと、その子・孫
  // カテゴリのキャラも表示される。「すべて」は全員を並び替えだけでフラットに
  // 表示する。「未分類」はカテゴリが1つも無いキャラ。
  // グループ作成のキャラ選択はこの一覧設定とは独立（シート内でカテゴリ絞り込みを持ち、
  // 並びは常に五十音順。v1.23）。
  // 名前検索はこれらと重ねて適用する: 表示名に入力文字列を含むキャラだけに
  // 絞り、入力が空なら全員が対象になる。照合はひらがなとカタカナを区別しない
  // （検索語と表示名の両方を normalizeKanaForSearch でそろえる）。
  const searchNeedle = normalizeKanaForSearch(searchQuery.trim());
  const displayedCharacters: CharacterItem[] = sortCharactersBy(
    characters.filter(
      (c) =>
        charMatchesFilter(c, categories, categoryFilter) &&
        (searchNeedle === "" || normalizeKanaForSearch(c.display_name).includes(searchNeedle)),
    ),
    sort,
  );

  // 「今すぐランダム作成」の実行（ローカル改善#7改訂）。キャラが3人未満なら
  // 作成せず、理由と現在の人数を表示する（サーバ側でも同じ文言で弾く）。
  // 3人以上ならサーバ側の共通経路で即作成する（抽選はサーバ側）。
  const handleAutoCreateGroup = () => {
    if (characters.length < 3) {
      setAutoCreateError(T.home.randomCreateNeedChars(characters.length));
      return;
    }
    setAutoCreateError("");
    autoCreateGroup.mutate();
  };

  // キャラ1件の描画（簡易表示の行／カード表示）。
  const renderCharRow = (c: CharacterItem, showChip: boolean = true) => (
    <div key={c.id} className="relative flex items-center gap-3 rounded-2xl px-3 py-2" style={{ background: "var(--surface)" }}>
      {c.unread_count > 0 && (
        <span aria-hidden="true" className="absolute inset-x-0 top-0 h-1 rounded-t-2xl" style={{ background: "var(--danger)" }} />
      )}
      <button
        type="button"
        onClick={() => openView({ kind: "chat", characterId: c.id, unreadFromSeq: c.first_unread_seq })}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
        aria-label={T.home.openChatAria(c.display_name, c.unread_count)}
      >
        <span className="relative shrink-0">
          <Avatar imageUrl={c.image_url} name={c.display_name} themeColor={c.theme_color} size={40} />
          {c.unread_count > 0 && (
            <span
              className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-black text-white"
              style={{ background: "var(--danger)" }}
            >
              {c.unread_count}
            </span>
          )}
        </span>
        <span className="font-display min-w-0 flex-1 truncate text-base font-bold" style={{ color: "var(--text)" }}>{c.display_name}</span>
        {showChip && charCategoryIds(c).length > 0 && (
          <span className="flex shrink-0 flex-wrap justify-end gap-1">
            {charCategoryIds(c).map((cid) => categoryNameById.get(cid) ? (
              <span key={cid} className="rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: "var(--surface-alt)", color: "var(--dim)" }}>
                {categoryNameById.get(cid)}
              </span>
            ) : null)}
          </span>
        )}
        <StatusBadge status={c.request_status} reviewing={c.reviewing} />
        {c.unreplied_count > 0 && c.request_status === "none" && (
          <span className="shrink-0 rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: "var(--accent-soft)", color: "var(--gold)" }}>
            {T.status.unreplied(c.unreplied_count)}
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={() => setMenuChar(c)}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
        style={{ background: "var(--surface-alt)", color: "var(--dim)" }}
        aria-label={T.home.settingsAria(c.display_name)}
      >
        <GearIcon />
      </button>
    </div>
  );

  const renderCharCard = (c: CharacterItem, showChip: boolean = true) => (
    <div key={c.id} className="relative rounded-3xl p-4" style={{ background: "var(--surface)" }}>
      {c.unread_count > 0 && (
        <span aria-hidden="true" className="absolute inset-x-0 top-0 h-1 rounded-t-3xl" style={{ background: "var(--danger)" }} />
      )}
      <button
        type="button"
        onClick={() => openView({ kind: "chat", characterId: c.id, unreadFromSeq: c.first_unread_seq })}
        className="flex w-full flex-col items-center gap-2 text-center"
        aria-label={T.home.openChatAria(c.display_name, c.unread_count)}
      >
        <span className="relative">
          <Avatar imageUrl={c.image_url} name={c.display_name} themeColor={c.theme_color} size={72} />
          {c.unread_count > 0 && (
            <span
              className="absolute -top-1 -right-1 flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs font-black text-white"
              style={{ background: "var(--danger)" }}
            >
              {c.unread_count}
            </span>
          )}
        </span>
        <span className="font-display w-full truncate text-base font-bold" style={{ color: "var(--text)" }}>{c.display_name}</span>
        {showChip && charCategoryIds(c).length > 0 && (
          <span className="flex flex-wrap justify-center gap-1">
            {charCategoryIds(c).map((cid) => categoryNameById.get(cid) ? (
              <span key={cid} className="rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: "var(--surface-alt)", color: "var(--dim)" }}>
                {categoryNameById.get(cid)}
              </span>
            ) : null)}
          </span>
        )}
        <span className="flex items-center gap-1">
          <StatusBadge status={c.request_status} reviewing={c.reviewing} />
          {c.unreplied_count > 0 && c.request_status === "none" && (
            <span className="rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: "var(--accent-soft)", color: "var(--gold)" }}>
              {T.status.unreplied(c.unreplied_count)}
            </span>
          )}
        </span>
      </button>
      <button
        type="button"
        onClick={() => setMenuChar(c)}
        className="absolute top-2 left-2 flex h-9 w-9 items-center justify-center rounded-full"
        style={{ background: "var(--surface-alt)", color: "var(--dim)" }}
        aria-label={T.home.settingsAria(c.display_name)}
      >
        <GearIcon />
      </button>
    </div>
  );

  return (
    <main className="mx-auto w-full max-w-2xl px-4 pb-10">
      <div className="mt-4 flex rounded-full p-1" style={{ background: "var(--surface-alt)" }} role="tablist" aria-label={T.home.tabListAria}>
        {(
          [
            { key: "personal", label: T.home.tabPersonal },
            { key: "group", label: T.home.tabGroup },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={homeTab === t.key}
            onClick={() => changeHomeTab(t.key)}
            className="flex-1 rounded-full px-4 py-2 font-bold"
            style={
              homeTab === t.key
                ? { background: "var(--surface)", color: "var(--text)", boxShadow: "0 1px 4px rgba(20,10,40,0.18)" }
                : { background: "transparent", color: "var(--dim)" }
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      {importStatus.data?.state === "running" && (
        <div className="mt-3 rounded-2xl px-4 py-3 text-sm" style={{ background: "var(--accent-soft)", color: "var(--text)" }} role="status">
          {T.importStatus.runningBanner(
            importStatus.data.started_at
              ? formatElapsed(elapsedSecondsSince(importStatus.data.started_at, importNow))
              : "",
          )}
        </div>
      )}
      {importStatus.data && (importStatus.data.state === "done" || importStatus.data.state === "failed") && importFinishedKey && importBannerDismissedFor !== importFinishedKey && importStatus.data.finished_at && Date.now() - new Date(importStatus.data.finished_at).getTime() < 10 * 60 * 1000 && (
        <div className="mt-3 flex items-start gap-2 rounded-2xl px-4 py-3 text-sm" style={{ background: "var(--accent-soft)", color: importStatus.data.state === "failed" ? "var(--danger)" : "var(--text)" }} role="status">
          <p className="min-w-0 flex-1">
            {importStatus.data.state === "done" ? T.importStatus.doneBanner(importStatus.data.note) : T.importStatus.failedBanner(importStatus.data.note)}
          </p>
          <button type="button" onClick={() => setImportBannerDismissedFor(importFinishedKey)} aria-label={T.importStatus.dismissAria} className="shrink-0 text-sm font-bold" style={{ color: "var(--dim)" }}>
            ×
          </button>
        </div>
      )}
      {homeTab === "personal" && (
      <section aria-label={T.home.charactersSectionAria}>
        <div className="mt-4 flex items-center justify-between">
          <h2 className="font-display text-xl font-black" style={{ color: "var(--text)" }}>{T.home.charactersHeading}</h2>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setShowOtherMenu(true)}
              className="rounded-full px-4 py-2 text-sm font-bold"
              style={{ background: "var(--surface-alt)", color: "var(--text)" }}
            >
              {T.home.other}
            </button>
            <button
              type="button"
              onClick={() => setShowImport(true)}
              className="rounded-full px-4 py-2 text-sm font-bold"
              style={{ background: "var(--surface-alt)", color: "var(--text)" }}
            >
              {T.home.addCharacter}
            </button>
          </div>
        </div>

        {characters.length > 0 && (
          <div className="mt-3">
            <label className="sr-only" htmlFor="char-search">{T.home.searchLabel}</label>
            <input
              id="char-search"
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={T.home.searchPlaceholder}
              className="w-full rounded-full px-4 py-2 text-sm"
              style={{ background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }}
            />
          </div>
        )}

        {characters.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="text-xs font-bold" style={{ color: "var(--dim)" }} htmlFor="char-sort">{T.home.sortLabel}</label>
            <select
              id="char-sort"
              value={sort}
              onChange={(e) => changeSort(e.target.value as CharSort)}
              className="rounded-full px-3 py-1.5 text-sm font-bold"
              style={{ background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }}
            >
              <option value="added">{T.home.sortAdded}</option>
              <option value="gojuon">{T.home.sortGojuon}</option>
              <option value="recent">{T.home.sortRecent}</option>
            </select>
            <button
              type="button"
              onClick={() => changeCompact(!compact)}
              aria-pressed={compact}
              className="rounded-full px-3 py-1.5 text-sm font-bold"
              style={{
                background: compact ? "var(--accent-soft)" : "var(--surface)",
                color: compact ? "var(--accent)" : "var(--text)",
                border: "1px solid var(--border)",
              }}
            >
              {T.home.compactToggle(compact)}
            </button>
            <CategoryFilterSelect id="char-category-filter" categories={categories} value={categoryFilter} onChange={setCategoryFilter} />
          </div>
        )}

        {characters.length === 0 ? (
          <div className="mt-4 rounded-3xl p-5" style={{ background: "var(--surface)" }}>
            <p className="text-sm leading-relaxed" style={{ color: "var(--dim)" }}>
              {T.home.noCharacters}
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                onClick={() => importKick.mutate()}
                disabled={importKick.isPending || importStatus.data?.state === "running"}
                className="rounded-full px-4 py-2.5 font-bold text-white disabled:opacity-50"
                style={{ background: "var(--accent)" }}
              >
                {importStatus.data?.state === "running" ? T.importStatus.running : T.home.bulkImport}
              </button>
              {importStatus.data?.state === "running" && (
                <p className="text-xs" style={{ color: "var(--dim)" }}>{T.importStatus.runningNote}</p>
              )}
              {importStatus.data?.state === "done" && importStatus.data.note && (
                <p className="text-xs" style={{ color: "var(--dim)" }}>{T.importStatus.doneNote(importStatus.data.note)}</p>
              )}
              {importStatus.data?.state === "failed" && (
                <p className="text-xs" style={{ color: "var(--danger)" }}>{T.importStatus.failedNote(importStatus.data.note)}</p>
              )}
              {importKick.isSuccess && importStatus.data?.state !== "running" && !importStatus.data?.note && (
                <p className="text-xs" style={{ color: "var(--dim)" }}>{T.home.importStarted}</p>
              )}
              <button
                type="button"
                onClick={() => setShowImport(true)}
                className="rounded-full px-4 py-2.5 font-bold"
                style={{ background: "var(--surface-alt)", color: "var(--text)" }}
              >
                {T.home.addByJson}
              </button>
            </div>
          </div>
        ) : displayedCharacters.length === 0 ? (
          <p className="mt-4 rounded-3xl p-5 text-sm" style={{ background: "var(--surface)", color: "var(--dim)" }}>
            {searchNeedle !== "" ? T.home.searchEmpty : T.home.categoryFilterEmpty}
          </p>
        ) : compact ? (
          <div className="mt-4 flex flex-col gap-2">
            {displayedCharacters.map((c) => renderCharRow(c))}
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {displayedCharacters.map((c) => renderCharCard(c))}
          </div>
        )}
      </section>
      )}

      {homeTab === "group" && (
      <>
      <section aria-label={T.home.groupsSectionAria}>
        <div className="mt-4 flex items-center justify-between">
          <h2 className="font-display text-xl font-black" style={{ color: "var(--text)" }}>{T.home.groupsHeading}</h2>
        </div>
        {/* 作成エリア（ローカル改善#7改訂）: 手動作成の「グループを作る」を主役
            として一番大きく一番上に置き、その下に自動作成の段として一段小さい
            ボタンを2つ横並び・同格で置く（即座／スケジュールの2パターン）。 */}
        <div className="mt-3 rounded-3xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          <button
            type="button"
            onClick={() => setShowCreateGroup(true)}
            disabled={characters.length < 1}
            className="w-full rounded-full px-4 py-3 text-base font-bold text-white disabled:opacity-40"
            style={{ background: "var(--accent)" }}
          >
            {T.home.createGroup}
          </button>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={handleAutoCreateGroup}
              disabled={autoCreateGroup.isPending}
              className="rounded-2xl px-3 py-2.5 text-left disabled:opacity-50"
              style={{ background: "var(--surface-alt)", color: "var(--text)" }}
              aria-label={T.home.randomCreateNow}
            >
              <span className="block text-sm font-bold">{autoCreateGroup.isPending ? T.home.randomCreating : T.home.randomCreateNow}</span>
              <span className="mt-0.5 block text-xs leading-relaxed" style={{ color: "var(--dim)" }}>{T.home.randomCreateNowDesc}</span>
            </button>
            <button
              type="button"
              onClick={() => scheduleSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
              className="rounded-2xl px-3 py-2.5 text-left"
              style={{ background: "var(--surface-alt)", color: "var(--text)" }}
              aria-label={T.home.randomCreateBySchedule}
            >
              <span className="block text-sm font-bold">{T.home.randomCreateBySchedule}</span>
              <span className="mt-0.5 block text-xs leading-relaxed" style={{ color: "var(--dim)" }}>{T.home.randomCreateByScheduleDesc}</span>
            </button>
          </div>
          {characters.length < 3 && (
            <p className="mt-2 text-sm leading-relaxed" role="status" style={{ color: "var(--danger)" }}>
              {T.home.randomCreateNeedChars(characters.length)}
            </p>
          )}
          {autoCreateError && characters.length >= 3 && (
            <p className="mt-2 text-sm" role="alert" style={{ color: "var(--danger)" }}>{autoCreateError}</p>
          )}
        </div>
        {groups.length === 0 ? (
          <p className="mt-3 text-sm" style={{ color: "var(--dim)" }}>
            {T.home.noGroups}
          </p>
        ) : (
          <>
          {deleteGroupError && (
            <p className="mt-3 text-sm" role="alert" style={{ color: "var(--danger)" }}>{deleteGroupError}</p>
          )}
          <div className="mt-3 flex flex-col gap-3">
            {pageGroups.map((g) => (
              <div
                key={g.id}
                className="relative flex w-full items-center gap-2 rounded-3xl p-4"
                style={{ background: "var(--surface)" }}
              >
                {g.unread_count > 0 && (
                  <span aria-hidden="true" className="absolute inset-x-0 top-0 h-1 rounded-t-3xl" style={{ background: "var(--danger)" }} />
                )}
                <button
                  type="button"
                  onClick={() => openView({ kind: "group", groupId: g.id, unreadFromSeq: g.first_unread_seq })}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  aria-label={T.home.openGroupAria(g.name, g.unread_count)}
                >
                  <span className="flex shrink-0 -space-x-3">
                    {g.member_image_urls.slice(0, 3).map((url, i) => (
                      <Avatar key={i} imageUrl={url} name={g.member_names[i] ?? "?"} themeColor="" size={40} />
                    ))}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="font-display block truncate font-bold" style={{ color: "var(--text)" }}>{g.name}</span>
                    <span className="block truncate text-xs" style={{ color: "var(--dim)" }}>
                      {g.status === "dissolved" ? T.home.groupDissolved : g.member_names.join("・")}
                    </span>
                  </span>
                  {g.unread_count > 0 && (
                    <span
                      className="flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full px-1 text-xs font-black text-white"
                      style={{ background: "var(--danger)" }}
                    >
                      {g.unread_count}
                    </span>
                  )}
                  <StatusBadge status={g.request_status} reviewing={g.reviewing} />
                  {g.unreplied_count > 0 && g.request_status === "none" && (
                    <span className="shrink-0 rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: "var(--accent-soft)", color: "var(--gold)" }}>
                      {T.status.unreplied(g.unreplied_count)}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => { setDeleteGroupError(""); setMenuGroup(g); }}
                  aria-label={T.home.groupMenuAria(g.name)}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-base leading-none"
                  style={{ background: "var(--surface-alt)", color: "var(--dim)" }}
                >
                  ⋯
                </button>
              </div>
            ))}
          </div>
          {groupPageCount > 1 && (
            <div className="mt-3 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => changeGroupPage(safeGroupPage - 1)}
                disabled={safeGroupPage === 0}
                aria-label={T.home.prevPage}
                className="rounded-full px-4 py-2 text-sm font-bold disabled:opacity-40"
                style={{ background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }}
              >
                {T.home.prevPage}
              </button>
              <span className="text-xs font-bold" style={{ color: "var(--dim)" }}>
                {T.home.pageIndicator(safeGroupPage + 1, groupPageCount, sortedGroups.length)}
              </span>
              <button
                type="button"
                onClick={() => changeGroupPage(safeGroupPage + 1)}
                disabled={safeGroupPage >= groupPageCount - 1}
                aria-label={T.home.nextPage}
                className="rounded-full px-4 py-2 text-sm font-bold disabled:opacity-40"
                style={{ background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }}
              >
                {T.home.nextPage}
              </button>
            </div>
          )}
          </>
        )}
      </section>

      <div ref={scheduleSectionRef} className="scroll-mt-4">
      <SchedulingSection
        data={schedulesQuery.data}
        isPending={schedulesQuery.isPending}
        isError={!!schedulesQuery.error}
        onRetry={() => schedulesQuery.refetch()}
        onCreate={() => setScheduleSheet({ mode: "create" })}
        onEdit={(s) => setScheduleSheet({ mode: "edit", schedule: s })}
      />
      </div>
      </>
      )}

      <p className="mt-10 text-xs leading-relaxed" style={{ color: "var(--dim)" }}>
        {T.home.footerNote}
      </p>

      {/* 全体設定（v2.1）: 返信到着時のClaudeへの通知 ON/OFF。 */}
      <section aria-label={T.home.globalSettingsAria} className="mt-10">
        <h2 className="font-display text-base font-black" style={{ color: "var(--text)" }}>{T.home.globalSettingsHeading}</h2>
        <label className="mt-3 flex items-start gap-3">
          <input
            type="checkbox"
            checked={settingsNotify}
            disabled={globalSettings.isPending || saveGlobalSettings.isPending}
            onChange={(e) => saveSettings({ notify_reply: e.target.checked })}
            aria-label={T.home.notifyReply}
            className="mt-0.5 h-5 w-5 shrink-0"
            style={{ accentColor: "var(--accent)" }}
          />
          <span>
            <span className="block text-sm font-bold" style={{ color: "var(--text)" }}>{T.home.notifyReply}</span>
            <span className="mt-1 block text-xs leading-relaxed" style={{ color: "var(--dim)" }}>
              {T.home.notifyReplyDesc}
            </span>
          </span>
        </label>

        {/* 返信を考えるAI（v3.5）: 通知設定の下に置く全体適用の選択。
            Claude の時だけモデルのプルダウンを出し、選択中のAIの注意点を
            その下に表示する。Muse の時はモデル欄自体を出さない
            （実行側のモデルはアプリからは選べないため）。 */}
        <div className="mt-5">
          <label className="text-sm font-bold" style={{ color: "var(--text)" }} htmlFor="reply-engine">{T.home.replyEngine}</label>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
              id="reply-engine"
              {...FIELDS.saveGlobalSettings.reply_engine}
              value={settingsEngine}
              disabled={globalSettings.isPending || saveGlobalSettings.isPending}
              onChange={(e) => saveSettings({ reply_engine: e.target.value as "claude" | "muse" })}
              className="rounded-full px-3 py-1.5 text-sm font-bold"
              style={{ background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }}
            >
              <option value="claude">{T.home.engineClaude}</option>
              <option value="muse">{T.home.engineMuse}</option>
            </select>
            {settingsEngine === "claude" && (
              <>
                <label className="text-xs font-bold" style={{ color: "var(--dim)" }} htmlFor="claude-model">{T.home.claudeModel}</label>
                <select
                  id="claude-model"
                  {...FIELDS.saveGlobalSettings.claude_model}
                  value={settingsModel}
                  disabled={globalSettings.isPending || saveGlobalSettings.isPending}
                  onChange={(e) => saveSettings({ claude_model: e.target.value as "sonnet" | "opus" | "haiku" | "auto" })}
                  className="rounded-full px-3 py-1.5 text-sm font-bold"
                  style={{ background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }}
                >
                  <option value="sonnet">Sonnet</option>
                  <option value="opus">Opus</option>
                  <option value="haiku">Haiku</option>
                  <option value="auto">{T.home.claudeModelAuto}</option>
                </select>
              </>
            )}
          </div>
          <p className="mt-2 text-xs leading-relaxed" style={{ color: "var(--dim)" }}>
            {T.home.replyEngineDesc}
          </p>
          <p className="mt-2 text-xs leading-relaxed" style={{ color: "var(--dim)" }}>
            {settingsEngine === "muse" ? T.home.engineMuseCaution : T.home.engineClaudeCaution}
          </p>
        </div>
        {saveGlobalSettings.isError && (
          <p className="mt-2 text-xs font-bold" style={{ color: "var(--danger)" }}>{T.home.globalSettingsSaveFailed}</p>
        )}
      </section>

      {/* 全体ログ（履歴ページ）への入口。目立たない形でページ下部に置く（設計書 v2.0 / D）。 */}
      <div className="mt-8 text-center">
        <button
          type="button"
          onClick={() => go({ kind: "logs" })}
          className="px-3 py-1.5 text-xs"
          style={{ color: "var(--dim)", opacity: 0.7 }}
        >
          {T.home.logsLink}
        </button>
      </div>

      {showImport && (
        <ImportSheet
          onClose={() => setShowImport(false)}
          onCreateNew={() => { setShowImport(false); setShowCreate(true); }}
        />
      )}
      {showCreate && <CharacterCreateSheet onClose={() => setShowCreate(false)} />}
      {showOtherMenu && (
        <OtherMenuSheet
          onClose={() => setShowOtherMenu(false)}
          onExportCharacters={() => { setShowCharExport(true); setShowOtherMenu(false); }}
          onCategoryManage={() => { setShowCategoryManage(true); setShowOtherMenu(false); }}
        />
      )}
      {showCharExport && (
        <CharacterExportSheet characters={characters} categories={categories} sort={sort} onClose={() => setShowCharExport(false)} />
      )}
      {showCreateGroup && (
        <CreateGroupSheet characters={characters} categories={categories} onClose={() => setShowCreateGroup(false)} go={openView} />
      )}
      {scheduleSheet && schedulesQuery.data && (
        <ScheduleEditSheet
          initial={scheduleSheet.mode === "edit" ? scheduleSheet.schedule : null}
          eligibleGroups={schedulesQuery.data.eligible_groups}
          categories={categories}
          onClose={() => setScheduleSheet(null)}
        />
      )}
      {showCategoryManage && (
        <CategoryManageSheet categories={categories} onClose={() => setShowCategoryManage(false)} />
      )}
      {menuChar && (
        <CharacterMenuSheet
          character={menuChar}
          onClose={() => setMenuChar(null)}
          onEditSettings={() => { setEditSettingsChar(menuChar); setMenuChar(null); }}
          onEditImage={() => { setImageEditChar(menuChar); setMenuChar(null); }}
          onRename={() => { setRenameChar(menuChar); setMenuChar(null); }}
          onSetCategory={() => { setCategoryAssignChar(menuChar); setMenuChar(null); }}
          onAutoTopic={() => { setAutoTopicChar(menuChar); setMenuChar(null); }}
          onDelete={() => { setConfirmDeleteChar(menuChar); setMenuChar(null); }}
        />
      )}
      {autoTopicChar && (
        <AutoTopicSheet
          targetKind="chat"
          targetId={autoTopicChar.id}
          targetName={T.autoTopic.chatTargetName(autoTopicChar.display_name)}
          currentEnabled={autoTopicChar.auto_topic_enabled}
          onClose={() => setAutoTopicChar(null)}
        />
      )}
      {categoryAssignChar && (
        <CategoryAssignSheet
          character={categoryAssignChar}
          categories={categories}
          onClose={() => setCategoryAssignChar(null)}
        />
      )}
      {editSettingsChar && (
        <CharacterSettingsEditSheet character={editSettingsChar} onClose={() => setEditSettingsChar(null)} />
      )}
      {renameChar && (
        <RenameCharacterSheet character={renameChar} onClose={() => setRenameChar(null)} />
      )}
      {imageEditChar && (
        <ImageEditSheet
          characterId={imageEditChar.id}
          characterName={imageEditChar.display_name}
          currentImageUrl={imageEditChar.image_url}
          onClose={() => setImageEditChar(null)}
        />
      )}
      {confirmDeleteChar && (
        <ConfirmSheet
          title={T.home.deleteCharacterTitle(confirmDeleteChar.display_name)}
          body={T.home.deleteCharacterBody}
          confirmLabel={T.common.deleteConfirm}
          busy={deleteChar.isPending}
          onCancel={() => setConfirmDeleteChar(null)}
          onConfirm={() => deleteChar.mutate(confirmDeleteChar.id)}
        />
      )}
      {menuGroup && (
        <GroupListMenuSheet
          group={menuGroup}
          onClose={() => setMenuGroup(null)}
          onDelete={() => { setConfirmDeleteGroup(menuGroup); setMenuGroup(null); }}
        />
      )}
      {confirmDeleteGroup && (
        <ConfirmSheet
          title={T.group.deleteConfirmTitle}
          body={T.group.deleteConfirmBody}
          confirmLabel={T.common.deleteConfirm}
          busy={deleteGroupFromList.isPending}
          onCancel={() => setConfirmDeleteGroup(null)}
          onConfirm={() => deleteGroupFromList.mutate(confirmDeleteGroup.id)}
        />
      )}
    </main>
  );
}

/** 書き出しJSONから代表画像のURLを取り出す（サーバ側が直接取得して保存する）。 */
function extractProfileImageUrl(text: string): string | undefined {
  try {
    const p = JSON.parse(text) as {
      images?: { file?: unknown; url?: unknown; is_primary?: unknown }[];
      image_base?: { image_ref?: unknown };
    };
    const imgs = Array.isArray(p.images) ? p.images : [];
    const primary = imgs.find((i) => i?.is_primary) ?? imgs[0];
    const candidates = [primary?.url, primary?.file, p.image_base?.image_ref];
    for (const c of candidates) {
      if (typeof c === "string" && /^https?:\/\//.test(c)) return c;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ scheduling (v2.0 / B)

// 曜日ラベルは display-texts.ts に集約（設計書 v3.3）。

function scheduleSummary(s: ScheduleItem): string {
  const freq = s.frequency === "weekly"
    ? T.schedule.freqWeekly(s.weekdays.map((d) => T.schedule.weekdayLabels[d] ?? "").filter(Boolean).join("・"))
    : T.schedule.freqDaily;
  const target = s.target_type === "existing"
    ? (s.target_group_name ? T.schedule.targetExisting(s.target_group_name) : T.schedule.targetMissing)
    : T.schedule.targetNew;
  return `${freq} ${s.times.join("・")} ／ ${target}`;
}

/** グループ一覧の下部に置く「スケジューリング」セクション。スケジュールの一覧・有効/無効・編集・削除と、作成ボタンを出す。 */
function SchedulingSection({
  data,
  isPending,
  isError,
  onRetry,
  onCreate,
  onEdit,
}: {
  data: SchedulesData | undefined;
  isPending: boolean;
  isError: boolean;
  onRetry: () => void;
  onCreate: () => void;
  onEdit: (s: ScheduleItem) => void;
}) {
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState<ScheduleItem | null>(null);
  const [error, setError] = useState("");
  const toggle = useMutation({
    mutationFn: async (v: { id: number; enabled: boolean }) => await api.setScheduleEnabled(v),
    onSuccess: () => {
      setError("");
      queryClient.invalidateQueries({ queryKey: ["schedules"] });
    },
    onError: (e) => setError(errMsg(e, T.schedule.toggleFailed)),
  });
  const del = useMutation({
    mutationFn: async (id: number) => await api.deleteSchedule({ id }),
    onSuccess: () => {
      setConfirmDelete(null);
      setError("");
      queryClient.invalidateQueries({ queryKey: ["schedules"] });
    },
    onError: (e) => setError(errMsg(e, T.common.deleteFailed)),
  });
  const schedules = data?.schedules ?? [];
  return (
    <section aria-label={T.schedule.sectionAria} className="mt-10">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-xl font-black" style={{ color: "var(--text)" }}>{T.schedule.heading}</h2>
        <button
          type="button"
          onClick={onCreate}
          className="rounded-full px-4 py-2 text-sm font-bold"
          style={{ background: "var(--surface-alt)", color: "var(--text)" }}
        >
          {T.schedule.create}
        </button>
      </div>
      <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--dim)" }}>
        {T.schedule.description}
      </p>
      {isPending && <p className="mt-3 text-sm" style={{ color: "var(--dim)" }}>{T.common.loading}</p>}
      {isError && (
        <div className="mt-3">
          <p className="text-sm" style={{ color: "var(--danger)" }}>{T.schedule.loadFailed}</p>
          <button type="button" onClick={onRetry} className="mt-2 rounded-full px-4 py-2 text-sm font-bold" style={{ background: "var(--surface-alt)", color: "var(--text)" }}>
            {T.common.reload}
          </button>
        </div>
      )}
      {data && schedules.length === 0 && (
        <p className="mt-3 text-sm" style={{ color: "var(--dim)" }}>{T.schedule.empty}</p>
      )}
      <div className="mt-3 flex flex-col gap-3">
        {schedules.map((s) => (
          <div key={s.id} className="rounded-3xl p-4" style={{ background: "var(--surface)" }}>
            <div className="flex items-center gap-2">
              <span className="font-display min-w-0 flex-1 truncate font-bold" style={{ color: "var(--text)" }}>{s.name}</span>
              <label className="flex shrink-0 items-center gap-1.5 text-xs font-bold" style={{ color: "var(--text)" }}>
                <input
                  type="checkbox"
                  checked={s.enabled}
                  disabled={toggle.isPending}
                  onChange={(e) => toggle.mutate({ id: s.id, enabled: e.target.checked })}
                  aria-label={T.schedule.enabledAria(s.name)}
                  className="h-5 w-5"
                  style={{ accentColor: "var(--accent)" }}
                />
                {s.enabled ? T.schedule.enabled : T.schedule.disabled}
              </label>
            </div>
            <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--dim)" }}>{scheduleSummary(s)}</p>
            {(() => {
              const parts = [
                s.target_type === "new"
                  ? s.category_ids.length === 0
                    ? T.schedule.drawFromAll(s.min_members, s.max_members)
                    : T.schedule.drawFromCategories(s.min_members, s.max_members)
                  : "",
                s.allow_guests ? T.schedule.guestsOn : "",
                s.allow_mobs ? T.schedule.mobsOn : "",
                s.target_type === "new" && s.allow_narration ? T.schedule.narrationOn : "",
                s.auto_topic_start ? T.schedule.topicStartOn : "",
              ].filter(Boolean);
              return parts.length ? (
                <p className="mt-0.5 text-xs leading-relaxed" style={{ color: "var(--dim)" }}>{parts.join(" ／ ")}</p>
              ) : null;
            })()}
            <div className="mt-2.5 flex gap-2">
              <button
                type="button"
                onClick={() => onEdit(s)}
                className="rounded-full px-4 py-1.5 text-sm font-bold"
                style={{ background: "var(--surface-alt)", color: "var(--text)" }}
              >
                {T.common.edit}
              </button>
              <button
                type="button"
                onClick={() => { setConfirmDelete(s); setError(""); }}
                className="rounded-full px-4 py-1.5 text-sm font-bold"
                style={{ background: "var(--surface-alt)", color: "var(--danger)" }}
              >
                {T.common.delete}
              </button>
            </div>
          </div>
        ))}
      </div>
      {error && <p className="mt-2 text-sm" style={{ color: "var(--danger)" }}>{error}</p>}
      {confirmDelete && (
        <ConfirmSheet
          title={T.schedule.deleteTitle(confirmDelete.name)}
          body={T.schedule.deleteBody}
          confirmLabel={T.common.deleteConfirm}
          busy={del.isPending}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => del.mutate(confirmDelete.id)}
        />
      )}
    </section>
  );
}

/** スケジュールの作成・編集シート。スケジュール側ではキャラを指定しない（対象チャットの設定を参照するため）。新規チャット型の時だけカテゴリ・人数・フレーバーを指定する。 */
function ScheduleEditSheet({
  initial,
  eligibleGroups,
  categories,
  onClose,
}: {
  initial: ScheduleItem | null;
  eligibleGroups: SchedulesData["eligible_groups"];
  categories: CategoryItem[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const F = FIELDS.createSchedule;
  const [name, setName] = useState(initial?.name ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [frequency, setFrequency] = useState<"daily" | "weekly">(initial?.frequency === "weekly" ? "weekly" : "daily");
  const [weekdays, setWeekdays] = useState<number[]>(initial?.weekdays ?? []);
  const [times, setTimes] = useState<string[]>(initial && initial.times.length ? initial.times : ["08:00"]);
  const [targetType, setTargetType] = useState<"existing" | "new">(initial?.target_type === "new" ? "new" : "existing");
  const [targetGroupId, setTargetGroupId] = useState<number | null>(initial?.target_group_id ?? null);
  const [categoryIds, setCategoryIds] = useState<number[]>(initial?.category_ids ?? []);
  const [minMembers, setMinMembers] = useState(initial?.min_members ?? 2);
  const [maxMembers, setMaxMembers] = useState(initial?.max_members ?? 4);
  const [allowGuests, setAllowGuests] = useState(initial?.allow_guests ?? false);
  const [allowMobs, setAllowMobs] = useState(initial?.allow_mobs ?? false);
  const [allowNarration, setAllowNarration] = useState(initial?.allow_narration ?? false);
  const [autoTopicStart, setAutoTopicStart] = useState(initial?.auto_topic_start ?? false);
  const [flavors, setFlavors] = useState<string[]>(initial?.flavors ?? []);
  const [error, setError] = useState("");

  // 生成時刻は保存用・検証用で同じ整形（空白除去・空欄除去）を使うため1回だけ計算する。
  const cleanedTimes = times.map((t) => t.trim()).filter(Boolean);
  const buildPayload = () => ({
    name: name.trim(),
    enabled,
    frequency,
    weekdays,
    times: cleanedTimes,
    target_type: targetType,
    target_group_id: targetType === "existing" ? targetGroupId : null,
    category_ids: categoryIds,
    min_members: minMembers,
    max_members: maxMembers,
    allow_guests: allowGuests,
    allow_mobs: allowMobs,
    allow_narration: allowNarration,
    auto_topic_start: autoTopicStart,
    flavors,
  });
  const save = useMutation({
    mutationFn: async () => {
      const p = buildPayload();
      return initial ? await api.updateSchedule({ id: initial.id, ...p }) : await api.createSchedule(p);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["schedules"] });
      onClose();
    },
    onError: (e) => setError(errMsg(e, T.common.saveFailed)),
  });
  const submit = () => {
    if (!name.trim()) { setError(T.scheduleEdit.nameRequired); return; }
    if (cleanedTimes.length === 0) { setError(T.scheduleEdit.timeRequired); return; }
    if (frequency === "weekly" && weekdays.length === 0) { setError(T.scheduleEdit.weekdayRequired); return; }
    if (targetType === "existing" && targetGroupId == null) { setError(T.scheduleEdit.targetGroupRequired); return; }
    // ローカル改善: 新規チャット型でカテゴリ未指定の場合は全キャラが対象になるため、未指定でも保存できる。
    if (minMembers > maxMembers) { setError(T.scheduleEdit.membersRangeError); return; }
    setError("");
    save.mutate();
  };
  // 対象グループの選択肢。編集時に現在の対象が選択肢（なりきり無効・解散していない
  // グループ）に無い場合は、現状が分かるよう注記つきで1件追加する。
  const groupOptions = [...eligibleGroups];
  if (initial?.target_group_id != null && !groupOptions.some((g) => g.id === initial.target_group_id)) {
    groupOptions.push({ id: initial.target_group_id, name: T.scheduleEdit.targetGroupUnavailable(initial.target_group_name ?? T.scheduleEdit.unknownGroup) });
  }
  const toggleWeekday = (d: number) =>
    setWeekdays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort((a, b) => a - b)));
  const toggleCategory = (id: number) =>
    setCategoryIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <div className="sheet-overlay fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(10,6,20,0.55)" }} role="dialog" aria-modal="true" aria-label={initial ? T.scheduleEdit.titleEdit : T.scheduleEdit.titleCreate}>
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded-3xl p-5" style={{ background: "var(--surface)" }}>
        <div className="flex items-start justify-between gap-3">
          <h2 className="font-display text-lg font-bold" style={{ color: "var(--text)" }}>{initial ? T.scheduleEdit.titleEdit : T.scheduleEdit.titleCreate}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={T.common.close}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-base"
            style={{ background: "var(--surface-alt)", color: "var(--dim)" }}
          >
            ×
          </button>
        </div>

        <label className="mt-4 block text-sm font-bold" style={{ color: "var(--text)" }} htmlFor="schedule-name">
          {T.scheduleEdit.nameLabel}
        </label>
        <input
          id="schedule-name"
          {...F.name}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={T.scheduleEdit.namePlaceholder}
          className="mt-1 w-full rounded-2xl px-3 py-2.5"
          style={editInputStyle}
        />
        <label className="mt-3 flex items-center gap-2 text-sm font-bold" style={{ color: "var(--text)" }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-5 w-5" style={{ accentColor: "var(--accent)" }} />
          {T.scheduleEdit.enableLabel}
        </label>

        <p className="mt-5 text-sm font-bold" style={{ color: "var(--text)" }}>{T.scheduleEdit.frequencyHeading}</p>
        <div className="mt-2 flex flex-col gap-1" role="radiogroup" aria-label={T.scheduleEdit.frequencyAria}>
          {(
            [
              { key: "daily", label: T.scheduleEdit.freqDaily },
              { key: "weekly", label: T.scheduleEdit.freqWeekly },
            ] as const
          ).map((o) => (
            <label key={o.key} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-2xl px-2 py-1.5" style={{ background: frequency === o.key ? "var(--accent-soft)" : "transparent" }}>
              <input type="radio" name="schedule-frequency" checked={frequency === o.key} onChange={() => setFrequency(o.key)} aria-label={o.label} className="h-5 w-5 shrink-0" />
              <span className="font-bold" style={{ color: "var(--text)" }}>{o.label}</span>
            </label>
          ))}
        </div>
        {frequency === "weekly" && (
          <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={T.scheduleEdit.weekdaysAria}>
            {T.schedule.weekdayLabels.map((label, d) => {
              const on = weekdays.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => toggleWeekday(d)}
                  aria-pressed={on}
                  aria-label={T.scheduleEdit.weekdayAria(label)}
                  className="h-10 w-10 rounded-full text-sm font-bold"
                  style={
                    on
                      ? { background: "var(--accent)", color: "#fff" }
                      : { background: "var(--surface-alt)", color: "var(--text)" }
                  }
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}
        <p className="mt-4 text-sm font-bold" style={{ color: "var(--text)" }}>{T.scheduleEdit.timesHeading}</p>
        <div className="mt-2 flex flex-col gap-2">
          {times.map((t, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="time"
                value={t}
                onChange={(e) => setTimes((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
                aria-label={T.scheduleEdit.timeAria(i)}
                className="rounded-2xl px-3 py-2.5"
                style={editInputStyle}
              />
              {times.length > 1 && (
                <button
                  type="button"
                  onClick={() => setTimes((prev) => prev.filter((_, j) => j !== i))}
                  aria-label={T.scheduleEdit.timeDeleteAria(i)}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-base"
                  style={{ background: "var(--surface-alt)", color: "var(--danger)" }}
                >
                  ×
                </button>
              )}
            </div>
          ))}
          {times.length < 10 && (
            <button
              type="button"
              onClick={() => setTimes((prev) => [...prev, "12:00"])}
              className="self-start rounded-full px-4 py-2 text-sm font-bold"
              style={{ background: "var(--surface-alt)", color: "var(--text)" }}
            >
              {T.scheduleEdit.addTime}
            </button>
          )}
        </div>

        <p className="mt-5 text-sm font-bold" style={{ color: "var(--text)" }}>{T.scheduleEdit.targetHeading}</p>
        <div className="mt-2 flex flex-col gap-1" role="radiogroup" aria-label={T.scheduleEdit.targetTypeAria}>
          {(
            [
              { key: "existing", label: T.scheduleEdit.targetExistingLabel, desc: T.scheduleEdit.targetExistingDesc },
              { key: "new", label: T.scheduleEdit.targetNewLabel, desc: T.scheduleEdit.targetNewDesc },
            ] as const
          ).map((o) => (
            <label key={o.key} className="flex cursor-pointer items-start gap-3 rounded-2xl px-2 py-2" style={{ background: targetType === o.key ? "var(--accent-soft)" : "transparent" }}>
              <input type="radio" name="schedule-target-type" checked={targetType === o.key} onChange={() => setTargetType(o.key)} aria-label={o.label} className="mt-0.5 h-5 w-5 shrink-0" />
              <span>
                <span className="block font-bold" style={{ color: "var(--text)" }}>{o.label}</span>
                <span className="mt-0.5 block text-xs leading-relaxed" style={{ color: "var(--dim)" }}>{o.desc}</span>
              </span>
            </label>
          ))}
        </div>

        {targetType === "existing" && (
          <div className="mt-3">
            <label className="block text-sm font-bold" style={{ color: "var(--text)" }} htmlFor="schedule-target-group">
              {T.scheduleEdit.targetGroupLabel}
            </label>
            <select
              id="schedule-target-group"
              value={targetGroupId === null ? "" : String(targetGroupId)}
              onChange={(e) => setTargetGroupId(e.target.value === "" ? null : Number(e.target.value))}
              className="mt-1 w-full rounded-2xl px-3 py-2.5"
              style={editInputStyle}
            >
              <option value="">{T.scheduleEdit.targetGroupPlaceholder}</option>
              {groupOptions.map((g) => (
                <option key={g.id} value={String(g.id)}>{g.name}</option>
              ))}
            </select>
            <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--dim)" }}>
              {T.scheduleEdit.targetGroupNote}
            </p>
          </div>
        )}

        {targetType === "new" && (
          <div className="mt-3">
            <p className="text-sm font-bold" style={{ color: "var(--text)" }}>{T.scheduleEdit.drawCategoriesHeading}</p>
            <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--dim)" }}>
              {T.scheduleEdit.drawCategoriesNote}
            </p>
            {categories.length === 0 && (
              <p className="mt-2 text-sm" style={{ color: "var(--dim)" }}>{T.scheduleEdit.noCategorySelected}</p>
            )}
            <div className="mt-2 flex flex-col gap-2" role="group" aria-label={T.common.categoryFilterGroupAria}>
              {categoryTreeEntries(categories).map(({ cat, depth }) => {
                const selected = categoryIds.includes(cat.id);
                return (
                  <label
                    key={cat.id}
                    className="flex items-center gap-3 rounded-2xl px-4 py-3"
                    style={{
                      background: selected ? "var(--accent-soft)" : "var(--surface-alt)",
                      color: "var(--text)",
                      outline: selected ? "2px solid var(--accent)" : "none",
                      marginLeft: depth * 20,
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleCategory(cat.id)}
                      aria-label={T.common.categoryAria(cat.name)}
                      className="h-5 w-5 shrink-0"
                      style={{ accentColor: "var(--accent)" }}
                    />
                    <span className="font-bold">
                      {depth > 0 && <span aria-hidden="true" style={{ color: "var(--dim)" }}>└ </span>}
                      {cat.name}
                    </span>
                    {selected && <span className="ml-auto text-xs font-bold" style={{ color: "var(--accent)" }}>{T.common.selected}</span>}
                  </label>
                );
              })}
            </div>
            {categories.length > 0 && categoryIds.length === 0 && (
              <p className="mt-2 rounded-2xl px-3 py-2 text-xs font-bold" role="status" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
                {T.scheduleEdit.noCategorySelected}
              </p>
            )}
            <div className="mt-3 flex items-center gap-3">
              <label className="text-sm font-bold" style={{ color: "var(--text)" }} htmlFor="schedule-min-members">{T.scheduleEdit.membersLabel}</label>
              <select
                id="schedule-min-members"
                value={String(minMembers)}
                onChange={(e) => setMinMembers(Number(e.target.value))}
                aria-label={T.scheduleEdit.minMembersAria}
                className="rounded-2xl px-3 py-2"
                style={editInputStyle}
              >
                {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                  <option key={n} value={String(n)}>{T.common.memberCount(n)}</option>
                ))}
              </select>
              <span style={{ color: "var(--dim)" }}>〜</span>
              <select
                value={String(maxMembers)}
                onChange={(e) => setMaxMembers(Number(e.target.value))}
                aria-label={T.scheduleEdit.maxMembersAria}
                className="rounded-2xl px-3 py-2"
                style={editInputStyle}
              >
                {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                  <option key={n} value={String(n)}>{T.common.memberCount(n)}</option>
                ))}
              </select>
            </div>
            <p className="mt-4 text-sm font-bold" style={{ color: "var(--text)" }}>{T.scheduleEdit.guestMobNarrationHeading}</p>
            <GuestMobToggles
              containerClassName="mt-2 flex flex-col gap-1"
              variant="simple"
              value={{ guests: allowGuests, mobs: allowMobs, narration: allowNarration }}
              onChange={(v) => { setAllowGuests(v.guests); setAllowMobs(v.mobs); setAllowNarration(v.narration); }}
              labels={{ guests: T.schedule.guestsOn, mobs: T.schedule.mobsOn, narration: T.schedule.narrationOn }}
            />
            <p className="mt-4 text-sm font-bold" style={{ color: "var(--text)" }}>{T.scheduleEdit.flavorsHeading}</p>
            <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--dim)" }}>
              {T.scheduleEdit.flavorsNote}
            </p>
            <div className="mt-2">
              <FlavorListEditor value={flavors} onChange={setFlavors} />
            </div>
          </div>
        )}

        <div className="mt-5">
          <label className="flex items-center gap-2 text-sm font-bold" style={{ color: "var(--text)" }}>
            <input type="checkbox" checked={autoTopicStart} onChange={(e) => setAutoTopicStart(e.target.checked)} className="h-5 w-5" style={{ accentColor: "var(--accent)" }} />
            {T.scheduleEdit.autoTopicStartLabel}
          </label>
          <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--dim)" }}>
            {T.scheduleEdit.autoTopicStartNote}
          </p>
        </div>

        {error && <p className="mt-3 text-sm" style={{ color: "var(--danger)" }}>{error}</p>}
        <div className="mt-4 flex gap-3">
          <button type="button" onClick={onClose} className="flex-1 rounded-full px-4 py-2.5 font-bold" style={{ background: "var(--surface-alt)", color: "var(--text)" }}>
            {T.common.cancel}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={save.isPending}
            className="flex-1 rounded-full px-4 py-2.5 font-bold text-white disabled:opacity-50"
            style={{ background: "var(--accent)" }}
          >
            {save.isPending ? T.common.saving : initial ? T.common.save : T.scheduleEdit.create}
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ app logs (v2.0 / D)

// 種別ラベルは display-texts.ts に集約（設計書 v3.3）。

/** 生成ログの本文を「リクエスト（プロンプト）」と「レスポンス（生の返信文）」へ
 * 分ける。生成ログの本文は `--- 見出し ---` 区切りの節の並びで、システム
 * プロンプト／ユーザープロンプトがリクエスト、「生レスポンス」節が
 * レスポンス、「失敗」節は失敗時の記録。分けられない形（節が無い等）は
 * null を返し、呼び出し側は従来通り本文をそのまま表示する。 */
function splitGenerationLogBody(body: string): { request: string; response: string } | null {
  const rebuilt: { title: string; text: string }[] = [];
  let cur: { title: string; lines: string[] } | null = null;
  for (const line of body.split("\n")) {
    const m = /^--- (.+) ---$/.exec(line);
    if (m) {
      if (cur) rebuilt.push({ title: cur.title, text: cur.lines.join("\n").trim() });
      cur = { title: m[1]!, lines: [] };
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  if (cur) rebuilt.push({ title: cur.title, text: cur.lines.join("\n").trim() });
  if (!rebuilt.length) return null;
  const requestParts = rebuilt.filter((s) => s.title === "システムプロンプト" || s.title === "ユーザープロンプト");
  const responseParts = rebuilt.filter((s) => s.title === "生レスポンス" || s.title === "失敗");
  if (!requestParts.length && !responseParts.length) return null;
  const others = rebuilt.filter((s) => !requestParts.includes(s) && !responseParts.includes(s));
  const request = [...requestParts, ...others].map((s) => `--- ${s.title} ---\n${s.text}`).join("\n\n");
  const response = responseParts.map((s) => (s.title === "失敗" ? `--- ${s.title} ---\n${s.text}` : s.text)).join("\n\n");
  return { request, response };
}

function LogBody({ id }: { id: number }) {
  const q = useQuery({ queryKey: ["app-log", id], queryFn: () => api.getAppLogBody({ id }) });
  if (q.isPending) return <p className="mt-2 text-sm" style={{ color: "var(--dim)" }}>{T.common.loading}</p>;
  if (q.error) {
    return (
      <div className="mt-2">
        <p className="text-sm" style={{ color: "var(--danger)" }}>{T.logs.bodyLoadFailed}</p>
        <button type="button" onClick={() => q.refetch()} className="mt-1 rounded-full px-3 py-1.5 text-xs font-bold" style={{ background: "var(--surface)", color: "var(--text)" }}>
          {T.common.reload}
        </button>
      </div>
    );
  }
  const body = q.data?.body ?? "";
  // 生成ログは、AIへ送ったリクエストとAIから貰ったレスポンスを別々に表示する。
  const split = q.data?.kind === "generation" && body ? splitGenerationLogBody(body) : null;
  if (split) {
    return (
      <div className="mt-2 flex flex-col gap-3">
        {split.request && (
          <div>
            <p className="text-xs font-bold" style={{ color: "var(--dim)" }}>{T.logs.requestHeading}</p>
            <pre className="mt-1 max-h-80 overflow-auto rounded-xl p-3 text-xs leading-relaxed whitespace-pre-wrap break-words" style={{ background: "var(--surface)", color: "var(--text)" }}>
              {split.request}
            </pre>
          </div>
        )}
        {split.response && (
          <div>
            <p className="text-xs font-bold" style={{ color: "var(--dim)" }}>{T.logs.responseHeading}</p>
            <pre className="mt-1 max-h-80 overflow-auto rounded-xl p-3 text-xs leading-relaxed whitespace-pre-wrap break-words" style={{ background: "var(--surface)", color: "var(--text)" }}>
              {split.response}
            </pre>
          </div>
        )}
      </div>
    );
  }
  const revision = q.data?.review_revision ?? null;
  // レビュー結果のログで生記録（自動レビュー分）が残っている場合は、
  // レビュー履歴と同じ形式でリクエスト／レスポンスも表示する。
  const record = q.data?.review_record ?? null;
  return (
    <>
      <pre className="mt-2 max-h-80 overflow-auto rounded-xl p-3 text-xs leading-relaxed whitespace-pre-wrap break-words" style={{ background: "var(--surface)", color: "var(--text)" }}>
        {body || T.logs.bodyEmpty}
      </pre>
      {record && <ReviewPromptResponse prompt={record.prompt_text} response={record.response_text} />}
      {revision && (
        <div className="mt-3">
          <p className="text-xs font-bold" style={{ color: "var(--dim)" }}>{T.reviewHistory.diffHeading(revision.diff.length)}</p>
          <div className="mt-1 flex flex-col gap-2">
            {revision.diff.map((d, i) => (
              <div key={i} className="rounded-xl p-2.5" style={{ background: "var(--surface)" }}>
                <p className="text-xs font-bold break-all" style={{ color: "var(--gold)" }}>{d.path}</p>
                <DiffValuePair before={d.before} after={d.after} />
              </div>
            ))}
          </div>
          <details className="mt-3">
            <summary className="cursor-pointer text-xs font-bold" style={{ color: "var(--dim)" }}>{T.reviewHistory.beforeJsonSummary}</summary>
            <pre className="mt-2 max-h-64 overflow-auto rounded-xl p-3 text-xs whitespace-pre-wrap break-all" style={{ background: "var(--surface)", color: "var(--text)" }}>{revision.before_json}</pre>
          </details>
          <details className="mt-3">
            <summary className="cursor-pointer text-xs font-bold" style={{ color: "var(--dim)" }}>{T.reviewHistory.fullJsonSummary}</summary>
            <pre className="mt-2 max-h-64 overflow-auto rounded-xl p-3 text-xs whitespace-pre-wrap break-all" style={{ background: "var(--surface)", color: "var(--text)" }}>{revision.after_json}</pre>
          </details>
          {revision.reverted_at && (
            <p className="mt-2 text-xs" style={{ color: "var(--dim)" }}>{T.reviewHistory.revertedNote(formatDateTime(revision.reverted_at))}</p>
          )}
        </div>
      )}
    </>
  );
}

/** 全体ログ（履歴ページ）。見出しのみの一覧で、タップした行だけ本文を個別に読み込んで開閉表示する。
 *  上部のチップで種別（タグ）ごとに絞り込める。絞り込みはサーバ側（listAppLogs の kind）で行う。 */
function LogsView({ back }: { back: () => void }) {
  const LOG_KINDS = ["user_send", "generation", "review", "settings", "auto"] as const;
  type LogKind = (typeof LOG_KINDS)[number];
  const [kindFilter, setKindFilter] = useState<LogKind | "all">("all");
  const logs = useQuery({
    queryKey: ["app-logs", kindFilter],
    queryFn: () => api.listAppLogs(kindFilter === "all" ? {} : { kind: kindFilter }),
    refetchInterval: 20000,
  });
  const [openId, setOpenId] = useState<number | null>(null);
  const items: AppLogItem[] = logs.data?.logs ?? [];
  const selectKind = (k: LogKind | "all") => {
    setKindFilter(k);
    setOpenId(null);
  };
  const chipStyle = (active: boolean) =>
    active
      ? { background: "var(--accent)", color: "#fff" }
      : { background: "var(--surface)", color: "var(--dim)" };
  return (
    <main className="mx-auto w-full max-w-2xl px-4 pb-10">
      <div className="mt-4 flex items-center gap-3">
        <button type="button" onClick={back} aria-label={T.common.backToList} className="flex h-10 w-10 items-center justify-center rounded-full text-xl" style={{ background: "var(--surface)", color: "var(--text)" }}>
          ←
        </button>
        <h2 className="font-display text-lg font-black" style={{ color: "var(--text)" }}>{T.logs.title}</h2>
      </div>
      <p className="mt-2 text-xs leading-relaxed" style={{ color: "var(--dim)" }}>
        {T.logs.description}
      </p>
      <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label={T.logs.filterGroupAria}>
        <button
          type="button"
          onClick={() => selectKind("all")}
          aria-pressed={kindFilter === "all"}
          aria-label={T.logs.filterAria(T.logs.filterAll)}
          className="rounded-full px-3 py-1.5 text-xs font-bold"
          style={chipStyle(kindFilter === "all")}
        >
          {T.logs.filterAll}
        </button>
        {LOG_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => selectKind(k)}
            aria-pressed={kindFilter === k}
            aria-label={T.logs.filterAria(T.logs.kindLabels[k] ?? k)}
            className="rounded-full px-3 py-1.5 text-xs font-bold"
            style={chipStyle(kindFilter === k)}
          >
            {T.logs.kindLabels[k] ?? k}
          </button>
        ))}
      </div>
      {logs.isPending && <p className="mt-6 text-center text-sm" style={{ color: "var(--dim)" }}>{T.common.loading}</p>}
      {logs.error && (
        <div className="mt-6 text-center">
          <p className="text-sm" style={{ color: "var(--danger)" }}>{T.common.loadFailed}</p>
          <button type="button" onClick={() => logs.refetch()} className="mt-3 rounded-full px-5 py-2 font-bold" style={{ background: "var(--surface-alt)", color: "var(--text)" }}>
            {T.common.reload}
          </button>
        </div>
      )}
      {logs.data && items.length === 0 && (
        <p className="mt-6 rounded-3xl p-5 text-sm" style={{ background: "var(--surface)", color: "var(--dim)" }}>
          {kindFilter === "all" ? T.logs.empty : T.logs.emptyForKind(T.logs.kindLabels[kindFilter] ?? kindFilter)}
        </p>
      )}
      <div className="mt-4 flex flex-col gap-2">
        {items.map((l) => {
          const open = openId === l.id;
          return (
            <div key={l.id} className="rounded-2xl px-3 py-2.5" style={{ background: "var(--surface-alt)" }}>
              <button
                type="button"
                onClick={() => setOpenId(open ? null : l.id)}
                aria-expanded={open}
                aria-label={T.logs.toggleAria(l.title, open)}
                className="flex w-full items-center gap-2 text-left"
              >
                <span className="shrink-0 rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: "var(--surface)", color: "var(--dim)" }}>
                  {T.logs.kindLabels[l.kind] ?? l.kind}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-bold" style={{ color: "var(--text)" }}>{l.title}</span>
                <span className="shrink-0 text-xs" style={{ color: "var(--dim)" }}>{formatDateTime(l.created_at)}</span>
                <span aria-hidden="true" className="shrink-0 text-xs" style={{ color: "var(--dim)" }}>{open ? "▲" : "▼"}</span>
              </button>
              {open && <LogBody id={l.id} />}
            </div>
          );
        })}
      </div>
    </main>
  );
}

function ImportSheet({ onClose, onCreateNew }: { onClose: () => void; onCreateNew: () => void }) {
  const queryClient = useQueryClient();
  const [json, setJson] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [fileBusy, setFileBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importChar = useMutation({
    mutationFn: async (text: string) => await api.importCharacter({ json: text, image_url: extractProfileImageUrl(text) }),
    onSuccess: (r) => {
      setDone(r.is_new ? T.importSheet.addedNotice(r.display_name) : T.importSheet.updatedNotice(r.display_name));
      setJson("");
      queryClient.invalidateQueries({ queryKey: ["home"] });
    },
    onError: (e) => setError(errMsg(e, T.importSheet.importFailed)),
  });
  // ファイル取り込み: 選んだ .json ファイルの内容を読み取り、貼り付けと
  // 同じ取り込み処理（importCharacter）へそのまま渡す。複数人分のJSON
  // （配列、または profiles 配列を持つ一括形式）が入ったファイルは、
  // 1人分ずつ同じ処理で順に取り込む。1件の失敗で全体は止めず、失敗した
  // キャラ名を集めて結果に表示する。
  const importFromFile = async (file: File) => {
    setError("");
    setDone("");
    let text: string;
    try {
      text = await file.text();
    } catch {
      setError(T.importSheet.fileReadFailed);
      return;
    }
    if (!text.trim()) {
      setError(T.importSheet.jsonRequired);
      return;
    }
    let entries: unknown[] | null = null;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) {
        entries = parsed;
      } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as { profiles?: unknown }).profiles)) {
        entries = (parsed as { profiles: unknown[] }).profiles;
      }
    } catch {
      // JSONとして読めない場合は単発フローへ渡し、サーバ側の検証エラーに委ねる。
    }
    if (!entries) {
      importChar.mutate(text);
      return;
    }
    if (entries.length === 0) {
      setError(T.importSheet.fileNoCharacters);
      return;
    }
    if (entries.length === 1) {
      importChar.mutate(typeof entries[0] === "string" ? (entries[0] as string) : JSON.stringify(entries[0]));
      return;
    }
    setFileBusy(true);
    let added = 0;
    let updated = 0;
    const failedNames: string[] = [];
    for (const entry of entries) {
      const entryText = typeof entry === "string" ? entry : JSON.stringify(entry);
      try {
        const r = await api.importCharacter({ json: entryText, image_url: extractProfileImageUrl(entryText) });
        if (r.is_new) added += 1;
        else updated += 1;
      } catch {
        const nm = entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string"
          ? ((entry as { name: string }).name)
          : "";
        failedNames.push(nm || "?");
      }
    }
    setFileBusy(false);
    queryClient.invalidateQueries({ queryKey: ["home"] });
    if (failedNames.length > 0) {
      setError(T.importSheet.multiPartial(added, updated, failedNames));
    } else {
      setDone(T.importSheet.multiDone(added, updated));
    }
  };
  const { importKick, importStatus, now: sheetNow } = useImportStatus();
  return (
    <div className="sheet-overlay fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(10,6,20,0.55)" }} role="dialog" aria-modal="true" aria-label={T.importSheet.title}>
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded-3xl p-5" style={{ background: "var(--surface)" }}>
        <h2 className="font-display text-lg font-bold" style={{ color: "var(--text)" }}>{T.importSheet.title}</h2>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--dim)" }}>
          {T.importSheet.description}
        </p>
        <label className="mt-4 block text-sm font-bold" style={{ color: "var(--text)" }} htmlFor="import-json">
          {T.importSheet.jsonLabel}
        </label>
        <textarea
          id="import-json"
          {...FIELDS.importCharacter.json}
          value={json}
          onChange={(e) => { setJson(e.target.value); setError(""); setDone(""); }}
          rows={8}
          placeholder='{"format": "avatar-profile", ...}'
          className="mt-1 w-full rounded-2xl p-3 text-xs"
          style={{ background: "var(--surface-alt)", color: "var(--text)", border: "1px solid var(--border)" }}
        />
        {error && <p className="mt-2 text-sm" style={{ color: "var(--danger)" }}>{error}</p>}
        {done && <p className="mt-2 text-sm" style={{ color: "var(--gold)" }}>{done}</p>}
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          aria-label={T.importSheet.fileButton}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void importFromFile(f);
          }}
        />
        <button
          type="button"
          disabled={importChar.isPending || fileBusy}
          onClick={() => fileInputRef.current?.click()}
          className="mt-3 w-full rounded-full px-4 py-2.5 font-bold disabled:opacity-50"
          style={{ background: "var(--surface-alt)", color: "var(--text)", border: "1px solid var(--border)" }}
        >
          {fileBusy ? T.importSheet.fileImporting : T.importSheet.fileButton}
        </button>
        <div className="mt-4 flex gap-3">
          <button type="button" onClick={onClose} className="flex-1 rounded-full px-4 py-2.5 font-bold" style={{ background: "var(--surface-alt)", color: "var(--text)" }}>
            {T.common.close}
          </button>
          <button
            type="button"
            disabled={importChar.isPending || fileBusy}
            onClick={() => {
              if (!json.trim()) { setError(T.importSheet.jsonRequired); return; }
              importChar.mutate(json);
            }}
            className="flex-1 rounded-full px-4 py-2.5 font-bold text-white disabled:opacity-50"
            style={{ background: "var(--accent)" }}
          >
            {T.importSheet.importButton}
          </button>
        </div>
        <div className="mt-5 border-t pt-4" style={{ borderColor: "var(--border)" }}>
          <button
            type="button"
            onClick={onCreateNew}
            className="w-full rounded-full px-4 py-2.5 font-bold"
            style={{ background: "var(--surface-alt)", color: "var(--text)" }}
          >
            {T.importSheet.createNewButton}
          </button>
        </div>
        <div className="mt-5 border-t pt-4" style={{ borderColor: "var(--border)" }}>
          <button
            type="button"
            onClick={() => importKick.mutate()}
            disabled={importKick.isPending || importStatus.data?.state === "running"}
            className="w-full rounded-full px-4 py-2.5 font-bold disabled:opacity-50"
            style={{ background: "var(--surface-alt)", color: "var(--text)" }}
          >
            {importStatus.data?.state === "running" ? T.importStatus.running : T.importSheet.bulkImportWithImages}
          </button>
          {importStatus.data?.state === "running" && (
            <p className="mt-2 text-xs" style={{ color: "var(--dim)" }} role="status">
              {T.importStatus.runningBanner(
                importStatus.data.started_at
                  ? formatElapsed(elapsedSecondsSince(importStatus.data.started_at, sheetNow))
                  : "",
              )} {T.importStatus.runningNote}
            </p>
          )}
          {importStatus.data?.state === "done" && (
            <p className="mt-2 text-xs" style={{ color: "var(--dim)" }} role="status">{T.importStatus.doneBanner(importStatus.data.note)}</p>
          )}
          {importStatus.data?.state === "failed" && (
            <p className="mt-2 text-xs" style={{ color: "var(--danger)" }} role="alert">{T.importStatus.failedBanner(importStatus.data.note)}</p>
          )}
          {importKick.isSuccess && importStatus.data?.state !== "running" && importStatus.data?.state !== "done" && importStatus.data?.state !== "failed" && (
            <p className="mt-2 text-xs" style={{ color: "var(--dim)" }}>{T.home.importStartedShort}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function CreateGroupSheet({ characters, categories, onClose, go }: { characters: CharacterItem[]; categories: CategoryItem[]; onClose: () => void; go: (v: View) => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [allowGuests, setAllowGuests] = useState(false);
  const [allowMobs, setAllowMobs] = useState(false);
  const [allowNarration, setAllowNarration] = useState(false);
  const [autoTitle, setAutoTitle] = useState(false);
  const [error, setError] = useState("");
  // シート内のカテゴリ絞り込み（v1.23、階層対応 v1.26）: "all" = 未指定（全員）/
  // "none" = 未分類のみ / 数値 = そのカテゴリ（子孫カテゴリを含む）。
  // 一覧側の絞り込み・並び替え設定とは独立に持ち、並びは設定に関わらず常に五十音順にする。
  const [catFilter, setCatFilter] = useState<CategoryFilter>("all");
  const visibleCharacters = sortCharactersBy(
    characters.filter((c) => charMatchesFilter(c, categories, catFilter)),
    "gojuon",
  );
  const create = useMutation({
    mutationFn: async () => await api.createGroup({ name: name.trim(), character_ids: selected, allow_guests: allowGuests, allow_mobs: allowMobs, allow_narration: allowNarration, auto_title: autoTitle }),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ["home"] });
      onClose();
      go({ kind: "group", groupId: r.id, unreadFromSeq: null });
    },
    onError: (e) => setError(errMsg(e, T.createGroup.createFailed)),
  });
  const toggle = (id: number) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 8) { setError(T.createGroup.maxMembersError); return prev; }
      setError("");
      return [...prev, id];
    });
  };
  return (
    <div className="sheet-overlay fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(10,6,20,0.55)" }} role="dialog" aria-modal="true" aria-label={T.createGroup.title}>
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded-3xl p-5" style={{ background: "var(--surface)" }}>
        <h2 className="font-display text-lg font-bold" style={{ color: "var(--text)" }}>{T.createGroup.title}</h2>
        <label className="mt-4 block text-sm font-bold" style={{ color: "var(--text)" }} htmlFor="group-name">{T.createGroup.nameLabel}</label>
        <input
          id="group-name"
          {...FIELDS.createGroup.name}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={T.createGroup.namePlaceholder}
          className="mt-1 w-full rounded-2xl px-3 py-2 text-sm"
          style={{ background: "var(--surface-alt)", color: "var(--text)", border: "1px solid var(--border)" }}
        />
        <label className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-2xl px-3 py-2.5" style={{ background: "var(--surface-alt)" }}>
          <input
            type="checkbox"
            checked={autoTitle}
            onChange={(e) => setAutoTitle(e.target.checked)}
            aria-label={T.createGroup.autoTitleLabel}
            className="mt-0.5 h-5 w-5 shrink-0"
          />
          <span>
            <span className="block text-sm font-bold" style={{ color: "var(--text)" }}>{T.createGroup.autoTitleLabel}</span>
            <span className="mt-0.5 block text-xs leading-relaxed" style={{ color: "var(--dim)" }}>{T.createGroup.autoTitleDesc}</span>
          </span>
        </label>
        <p className="mt-4 text-sm font-bold" style={{ color: "var(--text)" }}>{T.createGroup.membersHeading}</p>
        <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--dim)" }}>{T.createGroup.membersNote}</p>
        {categories.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <CategoryFilterSelect id="group-create-category-filter" categories={categories} value={catFilter} onChange={setCatFilter} />
            <span className="text-xs" style={{ color: "var(--dim)" }}>{T.common.selectedCount(selected.length)}</span>
          </div>
        )}
        <div className="mt-2 flex flex-col gap-1">
          {visibleCharacters.map((c) => (
            <label key={c.id} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-2xl px-2 py-1.5" style={{ background: selected.includes(c.id) ? "var(--accent-soft)" : "transparent" }}>
              <input
                type="checkbox"
                checked={selected.includes(c.id)}
                onChange={() => toggle(c.id)}
                aria-label={T.createGroup.joinAria(c.display_name)}
                className="h-5 w-5 shrink-0"
              />
              <Avatar imageUrl={c.image_url} name={c.display_name} themeColor={c.theme_color} size={36} />
              <span className="font-bold" style={{ color: "var(--text)" }}>{c.display_name}</span>
            </label>
          ))}
          {visibleCharacters.length === 0 && (
            <p className="px-2 py-3 text-sm" style={{ color: "var(--dim)" }}>{T.common.categoryEmpty}</p>
          )}
        </div>
        <p className="mt-4 text-sm font-bold" style={{ color: "var(--text)" }}>{T.createGroup.guestMobNarrationHeading}</p>
        <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--dim)" }}>{T.createGroup.guestMobNarrationNote}</p>
        <GuestMobToggles
          containerClassName="mt-2 flex flex-col gap-1"
          variant="simple"
          value={{ guests: allowGuests, mobs: allowMobs, narration: allowNarration }}
          onChange={(v) => { setAllowGuests(v.guests); setAllowMobs(v.mobs); setAllowNarration(v.narration); }}
          labels={{ guests: T.createGroup.guestLabel, mobs: T.createGroup.mobLabel, narration: T.createGroup.narrationLabel }}
        />
        {error && <p className="mt-2 text-sm" style={{ color: "var(--danger)" }}>{error}</p>}
        <div className="mt-4 flex gap-3">
          <button type="button" onClick={onClose} className="flex-1 rounded-full px-4 py-2.5 font-bold" style={{ background: "var(--surface-alt)", color: "var(--text)" }}>
            {T.common.cancel}
          </button>
          <button
            type="button"
            disabled={create.isPending}
            onClick={() => {
              if (selected.length < 1) { setError(T.createGroup.selectRequired); return; }
              create.mutate();
            }}
            className="flex-1 rounded-full px-4 py-2.5 font-bold text-white disabled:opacity-50"
            style={{ background: "var(--accent)" }}
          >
            {T.createGroup.create}
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ chat

function ChatView({ characterId, unreadFromSeq, back }: { characterId: number; unreadFromSeq: number | null; back: () => void }) {
  const queryClient = useQueryClient();
  useLockBodyScroll();
  const state = useQuery({
    queryKey: ["chat", characterId],
    queryFn: () => api.getChatState({ character_id: characterId }),
    refetchInterval: 10000,
  });
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState("");
  const [topicError, setTopicError] = useState("");
  const [failNotice, setFailNotice] = useState("");
  const [cancelNotice, setCancelNotice] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showFlavors, setShowFlavors] = useState(false);
  const [reviewMode, setReviewMode] = useState(false);
  const [selectedReviewId, setSelectedReviewId] = useState<number | null>(null);
  const [reviewError, setReviewError] = useState("");
  const [reviewNotice, setReviewNotice] = useState("");
  const [showReviewHistory, setShowReviewHistory] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dividerRef = useRef<HTMLDivElement | null>(null);
  const initialScrollDoneRef = useRef(false);
  const prevMsgCountRef = useRef(0);
  const msgCount = state.data?.messages.length ?? 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !state.data) return;
    if (!initialScrollDoneRef.current) {
      initialScrollDoneRef.current = true;
      prevMsgCountRef.current = msgCount;
      // 「新着」区切りがある時は、開いた直後に区切りの位置が見えるようにする。
      if (unreadFromSeq != null && dividerRef.current) {
        // scrollIntoView は文書を含む全ての祖先スクロールを動かし画面全体が
        // ずれるため、このスクロール領域の中だけで区切りが中央に来るよう計算する。
        const target = dividerRef.current;
        const delta = target.getBoundingClientRect().top - el.getBoundingClientRect().top;
        el.scrollTop += delta - (el.clientHeight - target.clientHeight) / 2;
        return;
      }
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (msgCount !== prevMsgCountRef.current) {
      prevMsgCountRef.current = msgCount;
      el.scrollTop = el.scrollHeight;
    }
  }, [msgCount, state.data, unreadFromSeq]);
  useDraftRestore(state.data?.draft, setDraft, setFailNotice);

  // 開いている間に新しい発言が見えたら、その都度サーバへ既読を明示する。
  // 一覧の新着バッジは遷移時に楽観的に消してあるが、開いたまま届いた返信も
  // 既読として確定させ、一覧へ戻った時にバッジが残らないようにする。
  const latestChatSeq = state.data?.messages[state.data.messages.length - 1]?.seq ?? 0;
  const markChatRead = useMutation({ mutationFn: async () => await api.markChatRead({ character_id: characterId }) });
  const markedChatSeqRef = useRef(0);
  const markChatReadMutate = markChatRead.mutate;
  useEffect(() => {
    if (latestChatSeq > markedChatSeqRef.current) {
      markedChatSeqRef.current = latestChatSeq;
      markChatReadMutate();
    }
  }, [latestChatSeq, markChatReadMutate]);

  const post = useMutation({
    // 送信時点のレビューモードを一緒に渡す。ON の送信では、返信生成の前に
    // 自動レビューが実行される（サーバ側の起動条件はこれだけ）。
    mutationFn: async (body: string) => await api.postMessage({ character_id: characterId, body, review_mode: reviewMode }),
    onSuccess: () => {
      setDraft("");
      setSendError("");
      setFailNotice("");
      setCancelNotice("");
      queryClient.invalidateQueries({ queryKey: ["chat", characterId] });
      queryClient.invalidateQueries({ queryKey: ["home"] });
    },
    onError: (e) => setSendError(errMsg(e, T.chat.sendFailed)),
  });
  // 「自動」ボタン（ローカル改善）: 押すと議題の仲介が起動し、少し遅れて
  // 議題が投稿される。投稿されれば既存の経路で返信生成が始まる。
  const topic = useMutation({
    mutationFn: async () => await api.requestTopic({ target_kind: "chat", target_id: characterId }),
    onSuccess: () => {
      setTopicError("");
      queryClient.invalidateQueries({ queryKey: ["chat", characterId] });
    },
    onError: (e) => setTopicError(errMsg(e, T.autoTopic.postFailed)),
  });
  const cancelSend = useMutation({
    mutationFn: async () => await api.cancelPendingSend({ target_kind: "chat", target_id: characterId }),
    onSuccess: (res) => {
      if (res.cancelled) {
        // 取り消した文章を入力欄へ戻す。入力途中の文章があれば、その前に連結する。
        setDraft((prev) => (prev.trim() ? `${res.restored_text}\n${prev}` : res.restored_text));
        setFailNotice("");
        setSendError("");
        setCancelNotice(T.chat.cancelDoneNotice);
      } else {
        setCancelNotice(T.chat.cancelTooLateNotice);
      }
      queryClient.invalidateQueries({ queryKey: ["chat", characterId] });
      queryClient.invalidateQueries({ queryKey: ["home"] });
    },
    onError: (e) => setSendError(errMsg(e, T.chat.cancelFailed)),
  });
  const clear = useMutation({
    mutationFn: async () => await api.clearChatHistory({ character_id: characterId }),
    onSuccess: () => {
      setConfirmClear(false);
      queryClient.invalidateQueries({ queryKey: ["chat", characterId] });
      queryClient.invalidateQueries({ queryKey: ["home"] });
    },
  });
  // 履歴の使用設定の切り替え（設計書 v3.2）。「使わない」へ切り替えた時点で
  // サーバ側が境界と新しい区間を記録する。
  const historyToggle = useMutation({
    mutationFn: async (v: boolean) => await api.setUseHistory({ target_kind: "chat", target_id: characterId, use_history: v }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["chat", characterId] });
    },
    onError: (e) => setSendError(errMsg(e, T.chat.historyChangeFailed)),
  });
  const submitReview = useMutation({
    mutationFn: async (args: { message_id: number; feedback: string }) =>
      await api.submitReview({ target_kind: "chat", target_id: characterId, message_id: args.message_id, feedback: args.feedback }),
    onSuccess: () => {
      setSelectedReviewId(null);
      setReviewError("");
      setReviewNotice(T.review.registeredNotice);
      queryClient.invalidateQueries({ queryKey: ["reviewHistory", characterId] });
    },
    onError: (e) => setReviewError(errMsg(e, T.review.submitFailed)),
  });

  const data: ChatState | undefined = state.data;
  const req = data?.request;
  const chatSegments = groupIntoSegments(data?.messages ?? []);
  // 区間フレーム内の発言描画で使うキャラ情報。発言がある時点で data は必ずある。
  const chatCharacter = data?.character;
  // 自動レビュー: その回の生成バッチ（request_id が同じ生成発言の並び）の
  // 最後の発言の後ろに「レビュー結果」ボタンを置く。表示の有無は、その回に
  // 自動レビューが走ったかどうかだけで決まる（現在の ON/OFF には連動しない）。
  const [autoReviewRequestId, setAutoReviewRequestId] = useState<number | null>(null);
  const autoReviewMap = new Map<number, AutoReviewItem[]>();
  for (const r of data?.auto_reviews ?? []) {
    const arr = autoReviewMap.get(r.request_id) ?? [];
    arr.push(r);
    autoReviewMap.set(r.request_id, arr);
  }
  const autoReviewBatchEndIds = new Set<number>();
  {
    const msgs = data?.messages ?? [];
    msgs.forEach((m, i) => {
      if (m.request_id != null && autoReviewMap.has(m.request_id)) {
        const next = msgs[i + 1];
        if (!next || next.request_id !== m.request_id) autoReviewBatchEndIds.add(m.id);
      }
    });
  }
  const selectedReviewMsg = data?.messages.find((m) => m.id === selectedReviewId && m.speaker === "character") ?? null;

  // 返信待ち（pending / 生成中）の間は送信できない。取り消しボタンは
  // 生成が始まる前（pending の間）だけ、未確認の利用者発言の最後の発言の
  // 下に出す。生成が始まったら（processing）もう取り消せないので出さない。
  const waiting = req?.status === "pending" || req?.status === "processing";
  const chatUserMsgs = (data?.messages ?? []).filter((m) => m.speaker === "user");
  const unrepliedMsgs = req?.status === "pending" && req.origin !== "auto" && req.unreplied_count > 0 ? chatUserMsgs.slice(-req.unreplied_count) : [];
  const cancelTargetId = unrepliedMsgs.length ? unrepliedMsgs[unrepliedMsgs.length - 1]!.id : null;

  // 送信ボタンと Enter キーで共用する送信処理。
  const submitDraft = () => {
    if (post.isPending) return;
    if (waiting) { setSendError(T.chat.waitingError); return; }
    if (!draft.trim()) { setSendError(T.chat.emptyMessageError); return; }
    post.mutate(draft.trim());
  };

  return (
    <div
      className="fixed top-0 right-0 left-0 mx-auto flex w-full max-w-2xl flex-col"
      style={{ height: "100dvh", background: "var(--bg)" }}
    >
      <header className="shrink-0 px-3 pt-safe pb-2" style={{ background: "var(--bg)" }}>
        <div className="flex items-center gap-3">
          <button type="button" onClick={back} aria-label={T.common.backToList} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xl" style={{ background: "var(--surface)", color: "var(--text)" }}>
            ←
          </button>
          {data && (
            <>
              <Avatar imageUrl={data.character.image_url} name={data.character.display_name} themeColor={data.character.theme_color} size={40} />
              <h2 className="font-display min-w-0 flex-1 truncate text-lg font-black" style={{ color: "var(--text)" }}>{data.character.display_name}</h2>
            </>
          )}
        </div>
        {data && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              className="shrink-0 rounded-full px-3 py-1.5 text-xs font-bold whitespace-nowrap"
              style={{ background: "var(--surface)", color: "var(--dim)" }}
            >
              {T.chat.clearHistory}
            </button>
            <button
              type="button"
              onClick={() => setShowExport(true)}
              className="shrink-0 rounded-full px-3 py-1.5 text-xs font-bold whitespace-nowrap"
              style={{ background: "var(--surface)", color: "var(--dim)" }}
            >
              {T.chat.export}
            </button>
            <button
              type="button"
              onClick={() => historyToggle.mutate(!data.use_history)}
              disabled={historyToggle.isPending}
              aria-pressed={data.use_history}
              aria-label={T.chat.historyToggleAria}
              className="shrink-0 rounded-full px-3 py-1.5 text-xs font-bold whitespace-nowrap disabled:opacity-50"
              style={
                data.use_history
                  ? { background: "var(--accent)", color: "#fff" }
                  : { background: "var(--surface)", color: "var(--dim)" }
              }
            >
              {data.use_history ? T.chat.historyOn : T.chat.historyOff}
            </button>
            <button
              type="button"
              onClick={() => setShowFlavors(true)}
              aria-label={T.flavors.buttonAria}
              aria-pressed={data.flavors.length > 0}
              className="shrink-0 rounded-full px-3 py-1.5 text-xs font-bold whitespace-nowrap"
              style={
                data.flavors.length > 0
                  ? { background: "var(--accent)", color: "#fff" }
                  : { background: "var(--surface)", color: "var(--dim)" }
              }
            >
              {data.flavors.length > 0 ? T.flavors.buttonWithCount(data.flavors.length) : T.flavors.button}
            </button>
            <ReviewModeToggle
              active={reviewMode}
              onToggle={() => {
                setReviewMode((v) => !v);
                setSelectedReviewId(null);
                setReviewError("");
              }}
            />
          </div>
        )}
      </header>

      {reviewMode && (
        <div className="mx-3 mt-1 flex items-center gap-2 rounded-xl px-3 py-2" style={{ background: "var(--surface)" }} role="status">
          <p className="min-w-0 flex-1 text-xs leading-relaxed" style={{ color: "var(--dim)" }}>
            {T.review.chatBanner}
          </p>
          <button
            type="button"
            onClick={() => setShowReviewHistory(true)}
            className="shrink-0 rounded-full px-3 py-1.5 text-xs font-bold"
            style={{ background: "var(--surface-alt)", color: "var(--text)" }}
          >
            {T.review.historyButton}
          </button>
        </div>
      )}

      {req && <RequestBanner request={req} />}

      {data?.topic_pending && (
        <div className="mx-3 mt-2 rounded-xl px-3 py-2 text-sm" style={{ background: "var(--accent-soft)", color: "var(--text)" }} role="status">
          {T.autoTopic.pendingBanner}
        </div>
      )}


      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-none py-3">
        {state.isPending && <p className="py-8 text-center text-sm" style={{ color: "var(--dim)" }}>{T.common.loading}</p>}
        {state.error && <p className="py-8 text-center text-sm" style={{ color: "var(--danger)" }}>{T.common.loadFailed}</p>}
        {data && data.messages.length === 0 && (
          <p className="py-8 text-center text-sm leading-relaxed" style={{ color: "var(--dim)" }}>
            {T.chat.emptyLine1}
            <br />{T.chat.emptyLine2}
          </p>
        )}
        <div className="flex flex-col">
          {chatSegments.map((seg, segIndex) => (
            <Fragment key={seg.segmentNo}>
              {segIndex > 0 && <SegmentBand date={seg.date} />}
              <div
                className={`relative z-10 flex flex-col gap-3 px-4 py-3 ${segIndex > 0 ? "rounded-t-3xl" : ""} ${segIndex < chatSegments.length - 1 ? "rounded-b-3xl" : ""}`}
                style={{ background: "var(--segment)" }}
              >
              {seg.messages.map((m) => (
            <Fragment key={m.id}>
              {unreadFromSeq != null && m.seq === unreadFromSeq && (
                <div ref={(el) => { dividerRef.current = el; }}>
                  <NewMessageDivider />
                </div>
              )}
              {m.is_topic ? (
              <div className="flex flex-col items-center">
                <TopicCard body={m.body} source={m.topic_source} />
                <span className="mt-0.5 text-xs" style={{ color: "var(--dim)" }}>{formatClock(m.created_at)}</span>
                {m.id === cancelTargetId && (
                  <CancelSendButton onCancel={() => cancelSend.mutate()} pending={cancelSend.isPending} />
                )}
              </div>
            ) : m.speaker === "user" ? (
              <div className="flex flex-col items-end">
                <div className="max-w-[82%] rounded-3xl rounded-br-md px-4 py-2.5 text-base whitespace-pre-wrap text-white" style={{ background: "var(--accent)" }}>
                  {m.body}
                </div>
                <span className="mt-0.5 text-xs" style={{ color: "var(--dim)" }}>{formatClock(m.created_at)}</span>
                {m.id === cancelTargetId && (
                  <CancelSendButton onCancel={() => cancelSend.mutate()} pending={cancelSend.isPending} />
                )}
              </div>
            ) : (
              <div className="flex items-start gap-2">
                <Avatar imageUrl={chatCharacter?.image_url ?? null} name={chatCharacter?.display_name ?? ""} themeColor={chatCharacter?.theme_color ?? ""} size={32} />
                <div className="flex max-w-[82%] flex-col">
                  {reviewMode ? (
                    <button
                      type="button"
                      onClick={() => { setSelectedReviewId(m.id); setReviewError(""); setReviewNotice(""); }}
                      aria-pressed={selectedReviewId === m.id}
                      aria-label={T.review.selectMessageAria(m.body.slice(0, 40))}
                      className="rounded-3xl rounded-bl-md px-4 py-2.5 text-left text-base whitespace-pre-wrap"
                      style={{
                        background: selectedReviewId === m.id ? "var(--accent-soft)" : "var(--surface)",
                        color: "var(--text)",
                        outline: selectedReviewId === m.id ? "2px solid var(--accent)" : "1.5px dashed var(--border)",
                        outlineOffset: 2,
                      }}
                    >
                      {m.body}
                    </button>
                  ) : (
                    <div className="rounded-3xl rounded-bl-md px-4 py-2.5 text-base whitespace-pre-wrap" style={{ background: "var(--surface)", color: "var(--text)" }}>
                      {m.body}
                    </div>
                  )}
                  <span className="mt-0.5 text-xs" style={{ color: "var(--dim)" }}>{formatClock(m.created_at)}</span>
                </div>
              </div>
              )}
              {autoReviewBatchEndIds.has(m.id) && (
                <AutoReviewResultButton onOpen={() => setAutoReviewRequestId(m.request_id)} />
              )}
            </Fragment>
              ))}
              </div>
            </Fragment>
          ))}
        </div>
      </div>

      <div className="shrink-0 px-3 pb-safe" style={{ background: "var(--bg)" }}>
        {reviewNotice && (
          <div className="mb-2 flex items-start gap-2 rounded-xl px-3 py-2" style={{ background: "var(--accent-soft)" }} role="status">
            <p className="min-w-0 flex-1 text-sm" style={{ color: "var(--text)" }}>{reviewNotice}</p>
            <button type="button" onClick={() => setReviewNotice("")} aria-label={T.chat.closeNoticeAria} className="shrink-0 text-sm font-bold" style={{ color: "var(--dim)" }}>×</button>
          </div>
        )}
        {reviewMode && selectedReviewMsg && data && (
          <ReviewPanel
            speakerName={data.character.display_name}
            messageBody={selectedReviewMsg.body}
            busy={submitReview.isPending}
            error={reviewError}
            onSubmit={(feedback) => submitReview.mutate({ message_id: selectedReviewMsg.id, feedback })}
            onCancel={() => { setSelectedReviewId(null); setReviewError(""); }}
            onOpenHistory={() => setShowReviewHistory(true)}
          />
        )}
        {failNotice && (
          <p className="mb-2 rounded-xl px-3 py-2 text-sm" style={{ background: "var(--accent-soft)", color: "var(--danger)" }} role="alert">
            {failNotice}
          </p>
        )}
        {cancelNotice && (
          <div className="mb-2 flex items-start gap-2 rounded-xl px-3 py-2" style={{ background: "var(--accent-soft)" }} role="status">
            <p className="min-w-0 flex-1 text-sm" style={{ color: "var(--text)" }}>{cancelNotice}</p>
            <button type="button" onClick={() => setCancelNotice("")} aria-label={T.chat.closeNoticeAria} className="shrink-0 text-sm font-bold" style={{ color: "var(--dim)" }}>×</button>
          </div>
        )}
        {reviewMode && (
          <p className="mb-1.5 rounded-xl px-3 py-2 text-xs leading-relaxed" style={{ background: "var(--accent-soft)", color: "var(--text)" }} role="status">
            {T.review.reviewModeNote}
          </p>
        )}
        <p className="mb-1.5 px-1 text-xs leading-relaxed" style={{ color: "var(--dim)" }}>
          {T.autoTopic.buttonHint(T.autoTopic.hint)}
        </p>
        <div className="flex items-end gap-2 pb-2">
          <button
            type="button"
            disabled={waiting || !!data?.topic_pending || topic.isPending}
            onClick={() => topic.mutate()}
            aria-label={T.autoTopic.buttonAria}
            className="shrink-0 rounded-full px-3 py-2.5 text-sm font-bold disabled:opacity-50"
            style={{ background: "var(--surface)", color: "var(--accent)", border: "1.5px solid var(--accent)" }}
          >
            {T.autoTopic.buttonLabel}
          </button>
          <label className="sr-only" htmlFor="chat-input">{T.chat.inputLabel}</label>
          <textarea
            id="chat-input"
            {...FIELDS.postMessage.body}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // PC では Enter で送信、Shift+Enter で改行。スマホでは Enter は
              // 改行（既定動作）にし、送信は送信ボタンで行う。日本語入力の
              // 変換確定 Enter では送信しない。
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !isTouchPrimary()) {
                e.preventDefault();
                submitDraft();
              }
            }}
            rows={2}
            placeholder={waiting ? T.chat.waitingPlaceholder : T.chat.inputPlaceholder}
            className="min-w-0 flex-1 rounded-3xl px-4 py-2.5 text-base"
            style={{ background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }}
          />
          <button
            type="button"
            disabled={post.isPending || waiting}
            onClick={submitDraft}
            className="shrink-0 rounded-full px-5 py-2.5 font-bold text-white disabled:opacity-50"
            style={{ background: "var(--accent)" }}
          >
            {T.chat.send}
          </button>
        </div>
        {sendError && <p className="pb-2 text-sm" style={{ color: "var(--danger)" }}>{sendError}</p>}
        {topicError && <p className="pb-2 text-sm" style={{ color: "var(--danger)" }}>{topicError}</p>}
      </div>

      {showExport && data && (
        <ExportSheet
          title={T.exportSheet.chatTitle(data.character.display_name)}
          queryKey={["export-chat", String(characterId)]}
          fetchText={() => api.exportChatText({ character_id: characterId })}
          onClose={() => setShowExport(false)}
        />
      )}

      {showFlavors && data && (
        <FlavorSheet
          targetKind="chat"
          targetId={characterId}
          current={data.flavors}
          onClose={() => setShowFlavors(false)}
        />
      )}

      {showReviewHistory && data && (
        <ReviewHistorySheet
          characterId={characterId}
          characterName={data.character.display_name}
          onClose={() => setShowReviewHistory(false)}
        />
      )}

      {autoReviewRequestId != null && autoReviewMap.get(autoReviewRequestId) && (
        <AutoReviewResultSheet
          reviews={autoReviewMap.get(autoReviewRequestId)!}
          onClose={() => setAutoReviewRequestId(null)}
        />
      )}

      {confirmClear && (
        <ConfirmSheet
          title={T.chat.clearConfirmTitle}
          body={T.chat.clearConfirmBody}
          confirmLabel={T.chat.clearConfirm}
          busy={clear.isPending}
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => clear.mutate()}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ group chat

/** なりきり設定シート（v1.19 / v1.20 / v1.30）: なりきるキャラの選択（未選択で解除）と、「なりきりキャラの台詞」の扱い（AIも演じる / 自分だけが演じる）を選ぶ。どちらを選んでも、発言したらAIは返信する。台詞の既定値は、なりきり未設定のグループでは「AIも演じる」。すでに保存済みのグループは保存値をそのまま初期値にし、「自分だけが演じる」を選んで保存した選択は変えない。 */
function RoleplaySheet({
  groupId,
  members,
  currentCharacterId,
  currentContinue,
  onClose,
}: {
  groupId: number;
  members: GroupState["members"];
  currentCharacterId: number | null;
  currentContinue: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<number | null>(currentCharacterId);
  // 既定値（v1.30）: なりきり未設定（currentCharacterId が null）のグループで
  // キャラを新たに選ぶ時は「AIも演じる」を既定にする。保存済みのグループは
  // 保存値 currentContinue をそのまま初期値にし、既存の選択を勝手に変えない。
  const [cont, setCont] = useState<boolean>(currentCharacterId == null ? true : currentContinue);
  const [error, setError] = useState("");
  const save = useMutation({
    mutationFn: async () => await api.setGroupRoleplay({ group_id: groupId, character_id: selected, continue_mode: cont }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["group", groupId] });
      queryClient.invalidateQueries({ queryKey: ["home"] });
      onClose();
    },
    onError: (e) => setError(errMsg(e, T.common.saveFailed)),
  });
  // なりきりに選べるのは、キャラ本体が存在し、現在も参加しているキャラだけ
  // （元参加者は過去の発言の参照用に members へ含まれているだけ）。
  const presentMembers = members.filter((m) => m.present && m.in_group);
  return (
    <div className="sheet-overlay fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(10,6,20,0.55)" }} role="dialog" aria-modal="true" aria-label={T.roleplay.title}>
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded-3xl p-5" style={{ background: "var(--surface)" }}>
        <h2 className="font-display text-lg font-bold" style={{ color: "var(--text)" }}>{T.roleplay.title}</h2>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--dim)" }}>
          {T.roleplay.description}
        </p>
        <p className="mt-4 text-sm font-bold" style={{ color: "var(--text)" }}>{T.roleplay.characterHeading}</p>
        <div className="mt-2 flex flex-col gap-1" role="radiogroup" aria-label={T.roleplay.characterHeading}>
          <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-2xl px-2 py-1.5" style={{ background: selected === null ? "var(--accent-soft)" : "transparent" }}>
            <input
              type="radio"
              name="roleplay-character"
              checked={selected === null}
              onChange={() => setSelected(null)}
              aria-label={T.roleplay.noneAria}
              className="h-5 w-5 shrink-0"
            />
            <span className="font-bold" style={{ color: "var(--text)" }}>{T.roleplay.noneLabel}</span>
          </label>
          {presentMembers.map((m) => (
            <label key={m.character_id} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-2xl px-2 py-1.5" style={{ background: selected === m.character_id ? "var(--accent-soft)" : "transparent" }}>
              <input
                type="radio"
                name="roleplay-character"
                checked={selected === m.character_id}
                onChange={() => setSelected(m.character_id)}
                aria-label={T.roleplay.asAria(m.display_name)}
                className="h-5 w-5 shrink-0"
              />
              <Avatar imageUrl={m.image_url} name={m.display_name} themeColor={m.theme_color} size={36} />
              <span className="font-bold" style={{ color: "var(--text)" }}>{m.display_name}</span>
            </label>
          ))}
        </div>
        {selected !== null && (
          <>
            <p className="mt-4 text-sm font-bold" style={{ color: "var(--text)" }}>{T.roleplay.linesHeading}</p>
            <div className="mt-2 flex flex-col gap-1" role="radiogroup" aria-label={T.roleplay.linesHeading}>
              <label className="flex cursor-pointer items-start gap-3 rounded-2xl px-2 py-2" style={{ background: cont ? "var(--accent-soft)" : "transparent" }}>
                <input
                  type="radio"
                  name="roleplay-continue"
                  checked={cont}
                  onChange={() => setCont(true)}
                  aria-label={T.roleplay.aiAlsoLabel}
                  className="mt-0.5 h-5 w-5 shrink-0"
                />
                <span>
                  <span className="block font-bold" style={{ color: "var(--text)" }}>{T.roleplay.aiAlsoLabel}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed" style={{ color: "var(--dim)" }}>{T.roleplay.aiAlsoDesc}</span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 rounded-2xl px-2 py-2" style={{ background: !cont ? "var(--accent-soft)" : "transparent" }}>
                <input
                  type="radio"
                  name="roleplay-continue"
                  checked={!cont}
                  onChange={() => setCont(false)}
                  aria-label={T.roleplay.selfOnlyLabel}
                  className="mt-0.5 h-5 w-5 shrink-0"
                />
                <span>
                  <span className="block font-bold" style={{ color: "var(--text)" }}>{T.roleplay.selfOnlyLabel}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed" style={{ color: "var(--dim)" }}>{T.roleplay.selfOnlyDesc}</span>
                </span>
              </label>
            </div>
          </>
        )}
        {error && <p className="mt-2 text-sm" style={{ color: "var(--danger)" }}>{error}</p>}
        <div className="mt-4 flex gap-3">
          <button type="button" onClick={onClose} className="flex-1 rounded-full px-4 py-2.5 font-bold" style={{ background: "var(--surface-alt)", color: "var(--text)" }}>
            {T.common.cancel}
          </button>
          <button
            type="button"
            disabled={save.isPending}
            onClick={() => save.mutate()}
            className="flex-1 rounded-full px-4 py-2.5 font-bold text-white disabled:opacity-50"
            style={{ background: "var(--accent)" }}
          >
            {save.isPending ? T.common.saving : T.roleplay.apply}
          </button>
        </div>
      </div>
    </div>
  );
}

/** グループ設定メニュー（グループ画面の「設定」ボタンから開く）。項目は「名前を変える」「参加者を変える」「生成内容の設定」「自動の設定」「グループを削除」の5つ。フレーバーは設定一覧には置かず、グループ画面上部のボタンから開くシートで選ぶ。履歴の使用設定も設定一覧には無く、グループ画面上部のタブで切り替える。 */
function GroupMenuSheet({
  groupName,
  onClose,
  onRename,
  onEditMembers,
  onGuestMob,
  onAutoTopic,
  onDelete,
}: {
  groupName: string;
  onClose: () => void;
  onRename: () => void;
  onEditMembers: () => void;
  onGuestMob: () => void;
  onAutoTopic: () => void;
  onDelete: () => void;
}) {
  const items: { label: string; description: string; danger?: boolean; onSelect: () => void }[] = [
    { label: T.groupMenu.rename, description: T.groupMenu.renameDesc, onSelect: onRename },
    { label: T.groupMenu.editMembers, description: T.groupMenu.editMembersDesc, onSelect: onEditMembers },
    { label: T.groupMenu.guestMob, description: T.groupMenu.guestMobDesc, onSelect: onGuestMob },
    { label: T.groupMenu.autoTopic, description: T.groupMenu.autoTopicDesc, onSelect: onAutoTopic },
    { label: T.groupMenu.deleteGroup, description: T.groupMenu.deleteGroupDesc, danger: true, onSelect: onDelete },
  ];
  return (
    <div className="sheet-overlay fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(10,6,20,0.55)" }} role="dialog" aria-modal="true" aria-label={T.groupMenu.menuAria}>
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded-3xl p-5" style={{ background: "var(--surface)" }}>
        <h2 className="font-display min-w-0 truncate text-lg font-bold" style={{ color: "var(--text)" }}>{T.groupMenu.title(groupName)}</h2>
        <div className="mt-4 flex flex-col gap-2">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={item.onSelect}
              className="w-full rounded-2xl px-4 py-3 text-left"
              style={{ background: "var(--surface-alt)", color: "var(--text)" }}
            >
              <span className="block font-bold" style={item.danger ? { color: "var(--danger)" } : undefined}>{item.label}</span>
              <span className="mt-0.5 block text-xs" style={{ color: "var(--dim)" }}>{item.description}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="mt-4 w-full rounded-full px-4 py-2.5 font-bold"
          style={{ background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }}
        >
          {T.common.close}
        </button>
      </div>
    </div>
  );
}

/** 生成内容の設定シート（グループ設定メニューの「生成内容の設定」から開く）。
 *  オンにすると、生成の場面に応じて参加者以外のキャラ（ゲスト）や名前のない人々
 *  （モブ）が会話に混じることがある。混じらないこともある。ナレーションは、会話の
 *  背景説明・場面転換・時間経過の説明が、誰の台詞でもない形で入ることがある。 */
function GroupGuestMobSheet({
  groupId,
  currentGuests,
  currentMobs,
  currentNarration,
  onClose,
}: {
  groupId: number;
  currentGuests: boolean;
  currentMobs: boolean;
  currentNarration: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [guests, setGuests] = useState(currentGuests);
  const [mobs, setMobs] = useState(currentMobs);
  const [narration, setNarration] = useState(currentNarration);
  const [error, setError] = useState("");
  const save = useMutation({
    mutationFn: async () => await api.setGroupGuestMob({ group_id: groupId, allow_guests: guests, allow_mobs: mobs, allow_narration: narration }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["group", groupId] });
      onClose();
    },
    onError: (e) => setError(errMsg(e, T.common.saveFailed)),
  });
  return (
    <div className="sheet-overlay fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(10,6,20,0.55)" }} role="dialog" aria-modal="true" aria-label={T.groupGuestMob.title}>
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded-3xl p-5" style={{ background: "var(--surface)" }}>
        <h2 className="font-display text-lg font-bold" style={{ color: "var(--text)" }}>{T.groupGuestMob.title}</h2>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--dim)" }}>
          {T.groupGuestMob.intro}
        </p>
        <GuestMobToggles
          containerClassName="mt-4 flex flex-col gap-2"
          variant="described"
          value={{ guests, mobs, narration }}
          onChange={(v) => { setGuests(v.guests); setMobs(v.mobs); setNarration(v.narration); }}
          labels={{
            guests: T.groupGuestMob.guestLabel,
            mobs: T.groupGuestMob.mobLabel,
            narration: T.groupGuestMob.narrationLabel,
            guestsDesc: T.groupGuestMob.guestDesc,
            mobsDesc: T.groupGuestMob.mobDesc,
            narrationDesc: T.groupGuestMob.narrationDesc,
          }}
        />
        {error && <p className="mt-2 text-sm" style={{ color: "var(--danger)" }}>{error}</p>}
        <div className="mt-4 flex gap-3">
          <button type="button" onClick={onClose} className="flex-1 rounded-full px-4 py-2.5 font-bold" style={{ background: "var(--surface-alt)", color: "var(--text)" }}>
            {T.common.cancel}
          </button>
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="flex-1 rounded-full px-4 py-2.5 font-bold text-white disabled:opacity-50"
            style={{ background: "var(--accent)" }}
          >
            {save.isPending ? T.common.saving : T.common.save}
          </button>
        </div>
      </div>
    </div>
  );
}

/** フレーバーの見出し: 貼られたテキストの先頭の非空行（サーバ側の見出しと同じ規則）。 */
function flavorTitleOf(text: string): string {
  const first = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return first.length > 60 ? `${first.slice(0, 60)}…` : first;
}

/**
 * フレーバー一式の編集部品（指定中の一覧＋貼り付け追加＋履歴からの追加）。
 * チャット用シート（変更のたびに即保存）とスケジュール編集シート（保存時に
 * まとめて送る）の両方で使う。履歴はアプリ全体で共有され、新しく指定した
 * フレーバーだけが最大10件まで残る（登録はサーバ側で行う）。
 */
function FlavorListEditor({
  value,
  onChange,
  disabled,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const [paste, setPaste] = useState("");
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);
  const history = useQuery({
    queryKey: ["flavor-history"],
    queryFn: () => api.getFlavorHistory({}),
  });
  const historyItems = history.data?.items ?? [];
  const addFlavor = (raw: string) => {
    const text = raw.trim();
    if (!text) { setError(T.flavors.emptyPasteError); return; }
    if (value.includes(text)) { setError(T.flavors.alreadyAddedError); return; }
    setError("");
    setPaste("");
    onChange([...value, text]);
  };
  return (
    <div>
      <p className="text-sm font-bold" style={{ color: "var(--text)" }}>{T.flavors.currentHeading}</p>
      {value.length === 0 ? (
        <p className="mt-2 text-sm" style={{ color: "var(--dim)" }}>{T.flavors.empty}</p>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          {value.map((f, i) => (
            <div key={`${i}-${f.slice(0, 24)}`} className="rounded-2xl px-3 py-2.5" style={{ background: "var(--surface-alt)" }}>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-bold" style={{ color: "var(--text)" }}>{flavorTitleOf(f)}</span>
                <button
                  type="button"
                  onClick={() => setExpanded(expanded === i ? null : i)}
                  aria-expanded={expanded === i}
                  className="shrink-0 rounded-full px-2.5 py-1 text-xs font-bold"
                  style={{ background: "var(--surface)", color: "var(--dim)" }}
                >
                  {expanded === i ? T.flavors.hideText : T.flavors.showText}
                </button>
                <button
                  type="button"
                  onClick={() => onChange(value.filter((_, j) => j !== i))}
                  disabled={disabled}
                  aria-label={T.flavors.removeAria(flavorTitleOf(f))}
                  className="shrink-0 rounded-full px-2.5 py-1 text-xs font-bold disabled:opacity-50"
                  style={{ background: "var(--surface)", color: "var(--danger)" }}
                >
                  {T.flavors.remove}
                </button>
              </div>
              {expanded === i && (
                <p className="mt-2 text-xs leading-relaxed whitespace-pre-wrap" style={{ color: "var(--text)" }}>{f}</p>
              )}
            </div>
          ))}
        </div>
      )}

      <p className="mt-5 text-sm font-bold" style={{ color: "var(--text)" }}>{T.flavors.addHeading}</p>
      <label className="mt-2 block text-xs font-bold" style={{ color: "var(--dim)" }} htmlFor="flavor-paste-text">
        {T.flavors.pasteLabel}
      </label>
      <textarea
        id="flavor-paste-text"
        value={paste}
        onChange={(e) => setPaste(e.target.value)}
        rows={6}
        placeholder={T.flavors.pastePlaceholder}
        className="mt-1 w-full rounded-2xl px-3 py-2.5 text-sm"
        style={{ background: "var(--surface-alt)", color: "var(--text)", border: "1px solid var(--border)" }}
      />
      <button
        type="button"
        onClick={() => addFlavor(paste)}
        disabled={disabled}
        className="mt-2 w-full rounded-full px-4 py-2.5 font-bold text-white disabled:opacity-50"
        style={{ background: "var(--accent)" }}
      >
        {T.flavors.addButton}
      </button>
      {error && <p className="mt-2 text-sm" style={{ color: "var(--danger)" }}>{error}</p>}

      <p className="mt-5 text-sm font-bold" style={{ color: "var(--text)" }}>{T.flavors.historyHeading}</p>
      <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--dim)" }}>{T.flavors.historyNote}</p>
      {historyItems.length === 0 ? (
        <p className="mt-2 text-sm" style={{ color: "var(--dim)" }}>{T.flavors.historyEmpty}</p>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          {historyItems.map((item) => {
            const already = value.includes(item.text);
            return (
              <button
                key={item.text}
                type="button"
                onClick={() => addFlavor(item.text)}
                disabled={disabled || already}
                aria-label={T.flavors.historyAddAria(item.title)}
                className="flex w-full items-center gap-2 rounded-2xl px-3 py-2.5 text-left disabled:opacity-50"
                style={{ background: "var(--surface-alt)", color: "var(--text)" }}
              >
                <span className="min-w-0 flex-1 truncate text-sm font-bold">{item.title}</span>
                {already && <span className="shrink-0 text-xs font-bold" style={{ color: "var(--dim)" }}>{T.flavors.historyAdded}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * フレーバーの選択シート（チャット上部の「フレーバー」ボタンから開く）。
 * 1対1・グループ共通。追加・取り外しのたびに即保存し、新しく指定された
 * フレーバーはサーバ側でフレーバー履歴へ登録される。
 */
function FlavorSheet({
  targetKind,
  targetId,
  current,
  onClose,
}: {
  targetKind: "chat" | "group";
  targetId: number;
  current: string[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [list, setList] = useState(current);
  const [error, setError] = useState("");
  const save = useMutation({
    mutationFn: async (next: string[]) => await api.setFlavors({ target_kind: targetKind, target_id: targetId, flavors: next }),
    onSuccess: (_res, next) => {
      setList(next);
      setError("");
      queryClient.invalidateQueries({ queryKey: [targetKind, targetId] });
      queryClient.invalidateQueries({ queryKey: ["flavor-history"] });
    },
    onError: (e) => setError(errMsg(e, T.flavors.saveFailed)),
  });
  return (
    <div className="sheet-overlay fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(10,6,20,0.55)" }} role="dialog" aria-modal="true" aria-label={T.flavors.title}>
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded-3xl p-5" style={{ background: "var(--surface)" }}>
        <h2 className="font-display text-lg font-bold" style={{ color: "var(--text)" }}>{T.flavors.title}</h2>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--dim)" }}>
          {T.flavors.description}
        </p>
        <div className="mt-4">
          <FlavorListEditor value={list} onChange={(next) => save.mutate(next)} disabled={save.isPending} />
        </div>
        {error && <p className="mt-2 text-sm" style={{ color: "var(--danger)" }}>{error}</p>}
        <button
          type="button"
          onClick={onClose}
          className="mt-5 w-full rounded-full px-4 py-2.5 font-bold"
          style={{ background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }}
        >
          {T.common.close}
        </button>
      </div>
    </div>
  );
}

/** グループ名の変更シート。参加者・会話履歴には影響しない。「名前はおまかせ」の
 * チェックもここで切り替え、おまかせ中は返信のたびに要約タイトルで名前が
 * 代入され直す。 */
function RenameGroupSheet({ groupId, currentName, currentAutoTitle, onClose }: { groupId: number; currentName: string; currentAutoTitle: boolean; onClose: () => void }) {
  const [autoTitle, setAutoTitle] = useState(currentAutoTitle);
  return (
    <RenameSheet
      texts={T.renameGroup}
      inputId="rename-group-name"
      fieldProps={FIELDS.renameGroup.name}
      currentName={currentName}
      onSave={async (v) => await api.renameGroup({ group_id: groupId, name: v, auto_title: autoTitle })}
      invalidateKeys={[["group", groupId], ["home"]]}
      onClose={onClose}
      extraChanged={autoTitle !== currentAutoTitle}
      extra={
        <label className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-2xl px-3 py-2.5" style={{ background: "var(--surface-alt)" }}>
          <input
            type="checkbox"
            checked={autoTitle}
            onChange={(e) => setAutoTitle(e.target.checked)}
            aria-label={T.renameGroup.autoTitleLabel}
            className="mt-0.5 h-5 w-5 shrink-0"
          />
          <span>
            <span className="block text-sm font-bold" style={{ color: "var(--text)" }}>{T.renameGroup.autoTitleLabel}</span>
            <span className="mt-0.5 block text-xs leading-relaxed" style={{ color: "var(--dim)" }}>{T.renameGroup.autoTitleDesc}</span>
          </span>
        </label>
      }
    />
  );
}

/** 参加者の変更シート。1〜8人の間で増減できる（1人だけでも保存できる）。なりきり中のキャラを外すと、なりきりは解除される（サーバ側でも未選択に戻す）。 */
function GroupMembersSheet({
  groupId,
  currentMemberIds,
  roleplayMember,
  onClose,
}: {
  groupId: number;
  currentMemberIds: number[];
  roleplayMember: { character_id: number; display_name: string } | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const home = useQuery({ queryKey: ["home"], queryFn: () => api.listHome({}) });
  const [selected, setSelected] = useState<number[]>(currentMemberIds);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const save = useMutation({
    mutationFn: async () => await api.updateGroupMembers({ group_id: groupId, character_ids: selected }),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ["group", groupId] });
      queryClient.invalidateQueries({ queryKey: ["home"] });
      if (r.roleplay_cleared) {
        setNotice(T.groupMembers.roleplayClearedNotice);
        // 解除されたことが分かるよう、通知を見せてから閉じられるようにする。
        setTimeout(onClose, 1200);
      } else {
        onClose();
      }
    },
    onError: (e) => setError(errMsg(e, T.common.changeFailed)),
  });
  const toggle = (id: number) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 8) { setError(T.createGroup.maxMembersError); return prev; }
      setError("");
      return [...prev, id];
    });
  };
  const characters: CharacterItem[] = home.data?.characters ?? [];
  const categories: CategoryItem[] = home.data?.categories ?? [];
  // シート内のカテゴリ絞り込み（v1.24、階層対応 v1.26）: グループ作成シートと機能を合わせる。
  // "all" = 未指定（全員）/ "none" = 未分類のみ / 数値 = そのカテゴリ（子孫カテゴリを含む）。
  // 並びは一覧側の設定に関わらず常に五十音順。絞り込みで隠れたキャラの選択は保持する。
  const [catFilter, setCatFilter] = useState<CategoryFilter>("all");
  const visibleCharacters = sortCharactersBy(
    characters.filter((c) => charMatchesFilter(c, categories, catFilter)),
    "gojuon",
  );
  const roleplayRemoved = roleplayMember != null && !selected.includes(roleplayMember.character_id);
  const submit = () => {
    if (selected.length < 1) { setError(T.groupMembers.minMembersError); return; }
    if (selected.length > 8) { setError(T.groupMembers.overMembersError); return; }
    setError("");
    save.mutate();
  };
  return (
    <div className="sheet-overlay fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(10,6,20,0.55)" }} role="dialog" aria-modal="true" aria-label={T.groupMembers.title}>
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded-3xl p-5" style={{ background: "var(--surface)" }}>
        <h2 className="font-display text-lg font-bold" style={{ color: "var(--text)" }}>{T.groupMembers.title}</h2>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--dim)" }}>
          {T.groupMembers.description}
        </p>
        <p className="mt-3 text-sm font-bold" style={{ color: "var(--text)" }}>{T.groupMembers.membersHeading(selected.length)}</p>
        {categories.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <CategoryFilterSelect id="group-members-category-filter" categories={categories} value={catFilter} onChange={setCatFilter} />
            <span className="text-xs" style={{ color: "var(--dim)" }}>{T.common.selectedCount(selected.length)}</span>
          </div>
        )}
        {home.isPending && <p className="mt-2 text-sm" style={{ color: "var(--dim)" }}>{T.common.loading}</p>}
        {home.error && (
          <div className="mt-2">
            <p className="text-sm" style={{ color: "var(--danger)" }}>{T.groupMembers.charactersLoadFailed}</p>
            <button type="button" onClick={() => home.refetch()} className="mt-2 rounded-full px-4 py-2 text-sm font-bold" style={{ background: "var(--surface-alt)", color: "var(--text)" }}>
              {T.common.reload}
            </button>
          </div>
        )}
        <div className="mt-2 flex flex-col gap-1">
          {visibleCharacters.map((c) => (
            <label key={c.id} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-2xl px-2 py-1.5" style={{ background: selected.includes(c.id) ? "var(--accent-soft)" : "transparent" }}>
              <input
                type="checkbox"
                checked={selected.includes(c.id)}
                onChange={() => toggle(c.id)}
                aria-label={T.createGroup.joinAria(c.display_name)}
                className="h-5 w-5 shrink-0"
              />
              <Avatar imageUrl={c.image_url} name={c.display_name} themeColor={c.theme_color} size={36} />
              <span className="font-bold" style={{ color: "var(--text)" }}>{c.display_name}</span>
              {currentMemberIds.includes(c.id) && (
                <span className="rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: "var(--surface-alt)", color: "var(--dim)" }}>{T.groupMembers.inGroupBadge}</span>
              )}
            </label>
          ))}
          {visibleCharacters.length === 0 && !home.isPending && (
            <p className="px-2 py-3 text-sm" style={{ color: "var(--dim)" }}>{T.common.categoryEmpty}</p>
          )}
        </div>
        {roleplayRemoved && roleplayMember && (
          <p className="mt-3 rounded-xl px-3 py-2 text-sm" style={{ background: "var(--accent-soft)", color: "var(--danger)" }} role="alert">
            {T.groupMembers.roleplayRemovedWarning(roleplayMember.display_name)}
          </p>
        )}
        {notice && (
          <p className="mt-3 rounded-xl px-3 py-2 text-sm" style={{ background: "var(--accent-soft)", color: "var(--text)" }} role="status">
            {notice}
          </p>
        )}
        {error && <p className="mt-2 text-sm" style={{ color: "var(--danger)" }}>{error}</p>}
        <div className="mt-4 flex gap-3">
          <button type="button" onClick={onClose} className="flex-1 rounded-full px-4 py-2.5 font-bold" style={{ background: "var(--surface-alt)", color: "var(--text)" }}>
            {T.common.cancel}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={save.isPending || selected.length < 1}
            className="flex-1 rounded-full px-4 py-2.5 font-bold text-white disabled:opacity-50"
            style={{ background: "var(--accent)" }}
          >
            {save.isPending ? T.common.saving : T.common.change}
          </button>
        </div>
      </div>
    </div>
  );
}

function GroupView({ groupId, unreadFromSeq, back }: { groupId: number; unreadFromSeq: number | null; back: () => void }) {
  const queryClient = useQueryClient();
  useLockBodyScroll();
  const state = useQuery({
    queryKey: ["group", groupId],
    queryFn: () => api.getGroupState({ group_id: groupId }),
    refetchInterval: 10000,
  });
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState("");
  const [topicError, setTopicError] = useState("");
  const [failNotice, setFailNotice] = useState("");
  const [cancelNotice, setCancelNotice] = useState("");
  const [confirm, setConfirm] = useState<"delete" | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [showRoleplay, setShowRoleplay] = useState(false);
  const [showGroupMenu, setShowGroupMenu] = useState(false);
  const [showRenameGroup, setShowRenameGroup] = useState(false);
  const [showEditMembers, setShowEditMembers] = useState(false);
  const [showGuestMob, setShowGuestMob] = useState(false);
  const [showFlavors, setShowFlavors] = useState(false);
  const [showGroupAutoTopic, setShowGroupAutoTopic] = useState(false);
  const [reviewMode, setReviewMode] = useState(false);
  const [selectedReviewId, setSelectedReviewId] = useState<number | null>(null);
  const [reviewError, setReviewError] = useState("");
  const [reviewNotice, setReviewNotice] = useState("");
  const [historyChar, setHistoryChar] = useState<{ id: number; name: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dividerRef = useRef<HTMLDivElement | null>(null);
  const initialScrollDoneRef = useRef(false);
  const prevMsgCountRef = useRef(0);
  const msgCount = state.data?.messages.length ?? 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !state.data) return;
    if (!initialScrollDoneRef.current) {
      initialScrollDoneRef.current = true;
      prevMsgCountRef.current = msgCount;
      // 「新着」区切りがある時は、開いた直後に区切りの位置が見えるようにする。
      if (unreadFromSeq != null && dividerRef.current) {
        // scrollIntoView は文書を含む全ての祖先スクロールを動かし画面全体が
        // ずれるため、このスクロール領域の中だけで区切りが中央に来るよう計算する。
        const target = dividerRef.current;
        const delta = target.getBoundingClientRect().top - el.getBoundingClientRect().top;
        el.scrollTop += delta - (el.clientHeight - target.clientHeight) / 2;
        return;
      }
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (msgCount !== prevMsgCountRef.current) {
      prevMsgCountRef.current = msgCount;
      el.scrollTop = el.scrollHeight;
    }
  }, [msgCount, state.data, unreadFromSeq]);
  useDraftRestore(state.data?.draft, setDraft, setFailNotice);

  // 1対1と同様、開いている間に見えた発言まで既読を明示する。
  const latestGroupSeq = state.data?.messages[state.data.messages.length - 1]?.seq ?? 0;
  const markGroupRead = useMutation({ mutationFn: async () => await api.markGroupRead({ group_id: groupId }) });
  const markedGroupSeqRef = useRef(0);
  const markGroupReadMutate = markGroupRead.mutate;
  useEffect(() => {
    if (latestGroupSeq > markedGroupSeqRef.current) {
      markedGroupSeqRef.current = latestGroupSeq;
      markGroupReadMutate();
    }
  }, [latestGroupSeq, markGroupReadMutate]);

  const post = useMutation({
    // 送信時点のレビューモードを一緒に渡す。ON の送信では、返信生成の前に
    // 自動レビューが実行される（サーバ側の起動条件はこれだけ）。
    mutationFn: async (body: string) => await api.postGroupPrompt({ group_id: groupId, body, review_mode: reviewMode }),
    onSuccess: () => {
      setDraft("");
      setSendError("");
      setFailNotice("");
      setCancelNotice("");
      queryClient.invalidateQueries({ queryKey: ["group", groupId] });
      queryClient.invalidateQueries({ queryKey: ["home"] });
    },
    onError: (e) => setSendError(errMsg(e, T.chat.sendFailed)),
  });
  // 「自動」ボタン（ローカル改善）: 1対1と同じく、押すと議題の仲介が
  // 起動し、少し遅れて議題が投稿され、掛け合い生成が始まる。
  const topic = useMutation({
    mutationFn: async () => await api.requestTopic({ target_kind: "group", target_id: groupId }),
    onSuccess: () => {
      setTopicError("");
      queryClient.invalidateQueries({ queryKey: ["group", groupId] });
    },
    onError: (e) => setTopicError(errMsg(e, T.autoTopic.postFailed)),
  });
  const cancelSend = useMutation({
    mutationFn: async () => await api.cancelPendingSend({ target_kind: "group", target_id: groupId }),
    onSuccess: (res) => {
      if (res.cancelled) {
        // 取り消した文章を入力欄へ戻す。入力途中の文章があれば、その前に連結する。
        setDraft((prev) => (prev.trim() ? `${res.restored_text}\n${prev}` : res.restored_text));
        setFailNotice("");
        setSendError("");
        setCancelNotice(T.chat.cancelDoneNotice);
      } else {
        setCancelNotice(T.chat.cancelTooLateNotice);
      }
      queryClient.invalidateQueries({ queryKey: ["group", groupId] });
      queryClient.invalidateQueries({ queryKey: ["home"] });
    },
    onError: (e) => setSendError(errMsg(e, T.chat.cancelFailed)),
  });
  // 履歴の使用設定の切り替え（設計書 v3.2）。上部タブのタップで即時に切り替える。
  // 「使わない」へ切り替えた時点でサーバ側が境界と新しい区間を記録する。
  const historyToggle = useMutation({
    mutationFn: async (v: boolean) => await api.setUseHistory({ target_kind: "group", target_id: groupId, use_history: v }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["group", groupId] });
    },
    onError: (e) => setSendError(errMsg(e, T.chat.historyChangeFailed)),
  });
  const del = useMutation({
    mutationFn: async () => await api.deleteGroup({ group_id: groupId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["home"] });
      back();
    },
  });
  const submitReview = useMutation({
    mutationFn: async (args: { message_id: number; feedback: string }) =>
      await api.submitReview({ target_kind: "group", target_id: groupId, message_id: args.message_id, feedback: args.feedback }),
    onSuccess: () => {
      setSelectedReviewId(null);
      setReviewError("");
      setReviewNotice(T.review.registeredNotice);
      queryClient.invalidateQueries({ queryKey: ["reviewHistory"] });
    },
    onError: (e) => setReviewError(errMsg(e, T.review.submitFailed)),
  });

  const data: GroupState | undefined = state.data;
  const req = data?.request;
  const groupSegments = groupIntoSegments(data?.messages ?? []);
  // 自動レビュー: 1対1と同じく、その回の生成バッチの最後の発言の後ろに
  // 「レビュー結果」ボタンを置く（表示はその回に自動レビューが走ったか
  // どうかだけで決まり、現在の ON/OFF には連動しない）。
  const [autoReviewRequestId, setAutoReviewRequestId] = useState<number | null>(null);
  const autoReviewMap = new Map<number, AutoReviewItem[]>();
  for (const r of data?.auto_reviews ?? []) {
    const arr = autoReviewMap.get(r.request_id) ?? [];
    arr.push(r);
    autoReviewMap.set(r.request_id, arr);
  }
  const autoReviewBatchEndIds = new Set<number>();
  {
    const msgs = data?.messages ?? [];
    msgs.forEach((m, i) => {
      if (m.request_id != null && autoReviewMap.has(m.request_id)) {
        const next = msgs[i + 1];
        if (!next || next.request_id !== m.request_id) autoReviewBatchEndIds.add(m.id);
      }
    });
  }

  // 返信待ち（pending / 生成中）の間は投稿できない。取り消しボタンは
  // 生成が始まる前（pending の間）だけ出す。対象は、未返信の話題がある時は
  // その最後の話題、なりきり発言への返信待ちの時は最後のなりきり発言。
  const waiting = req?.status === "pending" || req?.status === "processing";
  // 自動生成（auto）の開始待ちは送信取り消しの対象外（設計書 v2.0 / B）。
  const canCancel = req?.status === "pending" && req.origin !== "auto";
  const groupUserMsgs = (data?.messages ?? []).filter((m) => m.kind === "user");
  const unrepliedMsgs = canCancel && req.unreplied_count > 0 ? groupUserMsgs.slice(-req.unreplied_count) : [];
  const roleplayMsgs = (data?.messages ?? []).filter((m) => m.user_authored);
  const cancelTargetId =
    unrepliedMsgs.length
      ? unrepliedMsgs[unrepliedMsgs.length - 1]!.id
      : canCancel && roleplayMsgs.length
        ? roleplayMsgs[roleplayMsgs.length - 1]!.id
        : null;

  // 投稿ボタンと Enter キーで共用する投稿処理。
  const submitDraft = () => {
    if (post.isPending) return;
    if (waiting) { setSendError(T.group.waitingError); return; }
    if (!draft.trim()) { setSendError(data?.roleplay_character_id != null ? T.group.emptySpeechError : T.group.emptyTopicError); return; }
    post.mutate(draft.trim());
  };
  const dissolved = data?.group.status === "dissolved";
  const memberById = new Map((data?.members ?? []).map((m) => [m.character_id, m]));
  // なりきり中のキャラ（未設定・削除済みの場合は null）。
  const roleplayMember =
    data && data.roleplay_character_id != null ? memberById.get(data.roleplay_character_id) ?? null : null;
  const selectedReviewMsg = data?.messages.find((m) => m.id === selectedReviewId && m.kind === "character") ?? null;

  return (
    <div
      className="fixed top-0 right-0 left-0 mx-auto flex w-full max-w-2xl flex-col"
      style={{ height: "100dvh", background: "var(--bg)" }}
    >
      <header className="shrink-0 px-3 pt-safe pb-2" style={{ background: "var(--bg)" }}>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={back} aria-label={T.common.backToList} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xl" style={{ background: "var(--surface)", color: "var(--text)" }}>
            ←
          </button>
          <h2 className="font-display min-w-24 flex-1 truncate text-lg font-black" style={{ color: "var(--text)" }}>{data?.group.name ?? T.group.fallbackName}</h2>
          {data && data.group.status === "active" && (
            <button
              type="button"
              onClick={() => setShowGroupMenu(true)}
              aria-label={T.group.settingsAria}
              className="flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-bold"
              style={{ background: "var(--surface)", color: "var(--dim)" }}
            >
              <GearIcon />
              {T.group.settings}
            </button>
          )}
          {data && data.group.status === "active" && (
            <button
              type="button"
              onClick={() => historyToggle.mutate(!data.use_history)}
              disabled={historyToggle.isPending}
              aria-pressed={data.use_history}
              aria-label={T.chat.historyToggleAria}
              className="rounded-full px-3 py-1.5 text-xs font-bold disabled:opacity-50"
              style={
                data.use_history
                  ? { background: "var(--accent)", color: "#fff" }
                  : { background: "var(--surface)", color: "var(--dim)" }
              }
            >
              {T.group.historyTab(data.use_history)}
            </button>
          )}
          {data && data.group.status === "active" && (
            <button
              type="button"
              onClick={() => setShowFlavors(true)}
              aria-label={T.flavors.buttonAria}
              aria-pressed={data.flavors.length > 0}
              className="rounded-full px-3 py-1.5 text-xs font-bold"
              style={
                data.flavors.length > 0
                  ? { background: "var(--accent)", color: "#fff" }
                  : { background: "var(--surface)", color: "var(--dim)" }
              }
            >
              {data.flavors.length > 0 ? T.flavors.buttonWithCount(data.flavors.length) : T.flavors.button}
            </button>
          )}
          <button type="button" onClick={() => setShowExport(true)} className="rounded-full px-3 py-1.5 text-xs font-bold" style={{ background: "var(--surface)", color: "var(--dim)" }}>
            {T.group.export}
          </button>
          {data && data.group.status === "active" && (
            <button
              type="button"
              onClick={() => setShowRoleplay(true)}
              aria-pressed={data.roleplay_character_id != null}
              className="rounded-full px-3 py-1.5 text-xs font-bold"
              style={
                data.roleplay_character_id != null
                  ? { background: "var(--accent)", color: "#fff" }
                  : { background: "var(--surface)", color: "var(--dim)" }
              }
            >
              {T.group.roleplayButton}
            </button>
          )}
          <ReviewModeToggle
            active={reviewMode}
            onToggle={() => {
              setReviewMode((v) => !v);
              setSelectedReviewId(null);
              setReviewError("");
            }}
          />
        </div>
        {data && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {/* 参加者一覧には現在の参加者だけを出す（v1.24）。元参加者は
                members に過去発言の名前・画像の参照用として含まれているだけで、
                ここには表示しない。 */}
            {data.members.filter((m) => m.in_group).map((m) => (
              <span key={m.character_id} className="flex items-center gap-1.5 rounded-full py-1 pr-3 pl-1 text-xs font-bold" style={{ background: "var(--surface)", color: m.present ? "var(--text)" : "var(--dim)" }}>
                <Avatar imageUrl={m.image_url} name={m.display_name} themeColor={m.theme_color} size={22} />
                {m.display_name}{!m.present ? T.group.deletedSuffix : ""}
              </span>
            ))}
            {roleplayMember && (
              <span className="flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold text-white" style={{ background: "var(--accent)" }}>
                {T.group.roleplayChip(roleplayMember.display_name, data.roleplay_continue ? T.roleplay.aiAlsoLabel : T.roleplay.selfOnlyLabel)}
              </span>
            )}
          </div>
        )}
        {dissolved && (
          <p className="mt-2 rounded-xl px-3 py-2 text-sm" style={{ background: "var(--accent-soft)", color: "var(--dim)" }}>
            {T.group.dissolvedNote}
          </p>
        )}
      </header>

      {reviewMode && data && (
        <div className="mx-3 mt-1 rounded-xl px-3 py-2" style={{ background: "var(--surface)" }} role="status">
          <p className="text-xs leading-relaxed" style={{ color: "var(--dim)" }}>
            {T.review.groupBanner}
          </p>
        </div>
      )}

      {req && <RequestBanner request={req} isGroup />}

      {data?.topic_pending && (
        <div className="mx-3 mt-2 rounded-xl px-3 py-2 text-sm" style={{ background: "var(--accent-soft)", color: "var(--text)" }} role="status">
          {T.autoTopic.pendingBanner}
        </div>
      )}


      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-none py-3">
        {state.isPending && <p className="py-8 text-center text-sm" style={{ color: "var(--dim)" }}>{T.common.loading}</p>}
        {state.error && <p className="py-8 text-center text-sm" style={{ color: "var(--danger)" }}>{T.common.loadFailed}</p>}
        {data && data.messages.length === 0 && (
          <p className="py-8 text-center text-sm leading-relaxed" style={{ color: "var(--dim)" }}>
            {T.group.empty}
          </p>
        )}
        <div className="flex flex-col">
          {groupSegments.map((seg, segIndex) => (
            <Fragment key={seg.segmentNo}>
              {segIndex > 0 && <SegmentBand date={seg.date} />}
              <div
                className={`relative z-10 flex flex-col gap-3 px-4 py-3 ${segIndex > 0 ? "rounded-t-3xl" : ""} ${segIndex < groupSegments.length - 1 ? "rounded-b-3xl" : ""}`}
                style={{ background: "var(--segment)" }}
              >
              {seg.messages.map((m) => {
            const divider = unreadFromSeq != null && m.seq === unreadFromSeq ? (
              <div ref={(el) => { dividerRef.current = el; }}>
                <NewMessageDivider />
              </div>
            ) : null;
            // 自動レビューが走った回のバッチの最後の発言の後ろに置く結果ボタン。
            const autoReviewBtn = autoReviewBatchEndIds.has(m.id) ? (
              <AutoReviewResultButton onOpen={() => setAutoReviewRequestId(m.request_id)} />
            ) : null;
            if (m.kind === "user" && m.is_topic) {
              return (
                <Fragment key={m.id}>
                  {divider}
                  <div className="flex flex-col items-center">
                    <TopicCard body={m.body} source={m.topic_source} />
                    <span className="mt-0.5 text-xs" style={{ color: "var(--dim)" }}>{formatClock(m.created_at)}</span>
                    {m.id === cancelTargetId && (
                      <CancelSendButton onCancel={() => cancelSend.mutate()} pending={cancelSend.isPending} />
                    )}
                  </div>
                </Fragment>
              );
            }
            // 区間の区切りはフレームの途切れと帯で示す（設計書 v3.3）。
            if (m.kind === "user") {
              return (
                <Fragment key={m.id}>
                  {divider}
                  <div className="flex flex-col items-end">
                    <div className="max-w-[82%] rounded-3xl rounded-br-md px-4 py-2.5 text-base whitespace-pre-wrap text-white" style={{ background: "var(--accent)" }}>
                      {m.body}
                    </div>
                    <span className="mt-0.5 text-xs" style={{ color: "var(--dim)" }}>{T.group.topicTime(formatClock(m.created_at))}</span>
                    {m.id === cancelTargetId && (
                      <CancelSendButton onCancel={() => cancelSend.mutate()} pending={cancelSend.isPending} />
                    )}
                  </div>
                </Fragment>
              );
            }
            if (m.kind === "narration") {
              // ナレーション（v3.1）: 吹き出しにせず、アバター・名前なしで
              // 中央揃えのシステムメッセージ的に表示する。
              return (
                <Fragment key={m.id}>
                  {divider}
                  <div className="flex justify-center px-2 py-1">
                    <p className="max-w-[88%] text-center text-sm leading-relaxed whitespace-pre-wrap" style={{ color: "var(--dim)" }}>
                      {m.body}
                    </p>
                  </div>
                  {autoReviewBtn}
                </Fragment>
              );
            }
            if (m.kind === "raw") {
              return (
                <Fragment key={m.id}>
                  {divider}
                  <div className="rounded-2xl px-4 py-3" style={{ border: "1.5px dashed var(--danger)", background: "var(--surface)" }}>
                    <p className="text-xs font-bold" style={{ color: "var(--danger)" }}>{T.group.rawHeading}</p>
                    <p className="mt-1 text-sm whitespace-pre-wrap" style={{ color: "var(--text)" }}>{m.body}</p>
                  </div>
                  {autoReviewBtn}
                </Fragment>
              );
            }
            const member = m.character_id != null ? memberById.get(m.character_id) : undefined;
            // なりきり発言は、キャラのアイコンと名前の吹き出しにしつつ、
            // 利用者本人が書いた物だと分かるよう通常の送信と同じ色にする。
            // 自分で書いた発言はレビュー対象にしない。
            const isRoleplayLine = m.user_authored;
            return (
              <Fragment key={m.id}>
                {divider}
                <div className="flex items-start gap-2">
                <Avatar imageUrl={member?.image_url ?? null} name={m.speaker_name} themeColor={member?.theme_color ?? ""} size={32} />
                <div className="flex max-w-[82%] flex-col">
                  <span className="font-display mb-0.5 text-xs font-bold" style={{ color: "var(--dim)" }}>{m.speaker_name}</span>
                  {reviewMode && m.character_id != null && !isRoleplayLine ? (
                    <button
                      type="button"
                      onClick={() => { setSelectedReviewId(m.id); setReviewError(""); setReviewNotice(""); }}
                      aria-pressed={selectedReviewId === m.id}
                      aria-label={T.review.selectMessageAria(m.body.slice(0, 40))}
                      className="rounded-3xl rounded-bl-md px-4 py-2.5 text-left text-base whitespace-pre-wrap"
                      style={{
                        background: selectedReviewId === m.id ? "var(--accent-soft)" : "var(--surface)",
                        color: "var(--text)",
                        outline: selectedReviewId === m.id ? "2px solid var(--accent)" : "1.5px dashed var(--border)",
                        outlineOffset: 2,
                      }}
                    >
                      {m.body}
                    </button>
                  ) : isRoleplayLine ? (
                    <div className="rounded-3xl rounded-bl-md px-4 py-2.5 text-base whitespace-pre-wrap text-white" style={{ background: "var(--accent)" }}>
                      {m.body}
                    </div>
                  ) : (
                    <div className="rounded-3xl rounded-bl-md px-4 py-2.5 text-base whitespace-pre-wrap" style={{ background: "var(--surface)", color: "var(--text)" }}>
                      {m.body}
                    </div>
                  )}
                  <span className="mt-0.5 text-xs" style={{ color: "var(--dim)" }}>{formatClock(m.created_at)}</span>
                  {m.id === cancelTargetId && (
                    <CancelSendButton onCancel={() => cancelSend.mutate()} pending={cancelSend.isPending} selfStart />
                  )}
                </div>
                </div>
                {autoReviewBtn}
              </Fragment>
            );
              })}
              </div>
            </Fragment>
          ))}
        </div>
      </div>

      {!dissolved && (
        <div className="shrink-0 px-3 pb-safe" style={{ background: "var(--bg)" }}>
          {data && !data.use_history && (
            <p className="mb-2 rounded-xl px-3 py-2 text-sm" style={{ background: "var(--surface)", color: "var(--dim)", border: "1px solid var(--border)" }} role="note">
              {T.group.historyOffNote}
            </p>
          )}
          {reviewNotice && (
            <div className="mb-2 flex items-start gap-2 rounded-xl px-3 py-2" style={{ background: "var(--accent-soft)" }} role="status">
              <p className="min-w-0 flex-1 text-sm" style={{ color: "var(--text)" }}>{reviewNotice}</p>
              <button type="button" onClick={() => setReviewNotice("")} aria-label={T.chat.closeNoticeAria} className="shrink-0 text-sm font-bold" style={{ color: "var(--dim)" }}>×</button>
            </div>
          )}
          {reviewMode && selectedReviewMsg && selectedReviewMsg.character_id != null && (
            <ReviewPanel
              speakerName={selectedReviewMsg.speaker_name}
              messageBody={selectedReviewMsg.body}
              busy={submitReview.isPending}
              error={reviewError}
              onSubmit={(feedback) => submitReview.mutate({ message_id: selectedReviewMsg.id, feedback })}
              onCancel={() => { setSelectedReviewId(null); setReviewError(""); }}
              onOpenHistory={() => setHistoryChar({ id: selectedReviewMsg.character_id!, name: selectedReviewMsg.speaker_name })}
            />
          )}
          {failNotice && (
            <p className="mb-2 rounded-xl px-3 py-2 text-sm" style={{ background: "var(--accent-soft)", color: "var(--danger)" }} role="alert">
              {failNotice}
            </p>
          )}
          {cancelNotice && (
            <div className="mb-2 flex items-start gap-2 rounded-xl px-3 py-2" style={{ background: "var(--accent-soft)" }} role="status">
              <p className="min-w-0 flex-1 text-sm" style={{ color: "var(--text)" }}>{cancelNotice}</p>
              <button type="button" onClick={() => setCancelNotice("")} aria-label={T.chat.closeNoticeAria} className="shrink-0 text-sm font-bold" style={{ color: "var(--dim)" }}>×</button>
            </div>
          )}
          {reviewMode && (
            <p className="mb-1.5 rounded-xl px-3 py-2 text-xs leading-relaxed" style={{ background: "var(--accent-soft)", color: "var(--text)" }} role="status">
              {T.review.reviewModeNote}
            </p>
          )}
          <p className="mb-1.5 px-1 text-xs leading-relaxed" style={{ color: "var(--dim)" }}>
            {T.autoTopic.buttonHint(T.autoTopic.hint)}
          </p>
          <div className="flex items-end gap-2 pb-2">
            <button
              type="button"
              disabled={waiting || !!data?.topic_pending || topic.isPending}
              onClick={() => topic.mutate()}
              aria-label={T.autoTopic.buttonAria}
              className="shrink-0 rounded-full px-3 py-2.5 text-sm font-bold disabled:opacity-50"
              style={{ background: "var(--surface)", color: "var(--accent)", border: "1.5px solid var(--accent)" }}
            >
              {T.autoTopic.buttonLabel}
            </button>
            <label className="sr-only" htmlFor="group-input">{T.group.inputLabel}</label>
            <textarea
              id="group-input"
              {...FIELDS.postGroupPrompt.body}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // PC では Enter で投稿、Shift+Enter で改行。スマホでは Enter は
                // 改行（既定動作）にし、投稿は投稿ボタンで行う。日本語入力の
                // 変換確定 Enter では投稿しない。
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !isTouchPrimary()) {
                  e.preventDefault();
                  submitDraft();
                }
              }}
              rows={2}
              placeholder={
                waiting
                  ? T.group.waitingPlaceholder
                  : roleplayMember
                    ? T.group.roleplayPlaceholder(roleplayMember.display_name)
                    : T.group.inputPlaceholder
              }
              className="min-w-0 flex-1 rounded-3xl px-4 py-2.5 text-base"
              style={{ background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }}
            />
            <button
              type="button"
              disabled={post.isPending || waiting}
              onClick={submitDraft}
              className="shrink-0 rounded-full px-5 py-2.5 font-bold text-white disabled:opacity-50"
              style={{ background: "var(--accent)" }}
            >
              {roleplayMember ? T.group.speak : T.group.post}
            </button>
          </div>
          {sendError && <p className="pb-2 text-sm" style={{ color: "var(--danger)" }}>{sendError}</p>}
          {topicError && <p className="pb-2 text-sm" style={{ color: "var(--danger)" }}>{topicError}</p>}
        </div>
      )}

      {historyChar && (
        <ReviewHistorySheet
          characterId={historyChar.id}
          characterName={historyChar.name}
          onClose={() => setHistoryChar(null)}
        />
      )}

      {autoReviewRequestId != null && autoReviewMap.get(autoReviewRequestId) && (
        <AutoReviewResultSheet
          reviews={autoReviewMap.get(autoReviewRequestId)!}
          onClose={() => setAutoReviewRequestId(null)}
        />
      )}

      {showRoleplay && data && (
        <RoleplaySheet
          groupId={groupId}
          members={data.members}
          currentCharacterId={data.roleplay_character_id}
          currentContinue={data.roleplay_continue}
          onClose={() => setShowRoleplay(false)}
        />
      )}

      {showGroupMenu && data && (
        <GroupMenuSheet
          groupName={data.group.name}
          onClose={() => setShowGroupMenu(false)}
          onRename={() => {
            setShowGroupMenu(false);
            setShowRenameGroup(true);
          }}
          onEditMembers={() => {
            setShowGroupMenu(false);
            setShowEditMembers(true);
          }}
          onGuestMob={() => {
            setShowGroupMenu(false);
            setShowGuestMob(true);
          }}
          onAutoTopic={() => {
            setShowGroupMenu(false);
            setShowGroupAutoTopic(true);
          }}
          onDelete={() => {
            setShowGroupMenu(false);
            setConfirm("delete");
          }}
        />
      )}

      {showGroupAutoTopic && data && (
        <AutoTopicSheet
          targetKind="group"
          targetId={groupId}
          targetName={T.autoTopic.groupTargetName(data.group.name)}
          currentEnabled={data.auto_topic_enabled}
          onClose={() => setShowGroupAutoTopic(false)}
        />
      )}

      {showFlavors && data && (
        <FlavorSheet
          targetKind="group"
          targetId={groupId}
          current={data.flavors}
          onClose={() => setShowFlavors(false)}
        />
      )}

      {showGuestMob && data && (
        <GroupGuestMobSheet
          groupId={groupId}
          currentGuests={data.allow_guests}
          currentMobs={data.allow_mobs}
          currentNarration={data.allow_narration}
          onClose={() => setShowGuestMob(false)}
        />
      )}

      {showRenameGroup && data && (
        <RenameGroupSheet
          groupId={groupId}
          currentName={data.group.name}
          currentAutoTitle={data.auto_title}
          onClose={() => setShowRenameGroup(false)}
        />
      )}

      {showEditMembers && data && (
        <GroupMembersSheet
          groupId={groupId}
          currentMemberIds={data.members.filter((m) => m.in_group).map((m) => m.character_id)}
          roleplayMember={roleplayMember ? { character_id: roleplayMember.character_id, display_name: roleplayMember.display_name } : null}
          onClose={() => setShowEditMembers(false)}
        />
      )}

      {showExport && data && (
        <ExportSheet
          title={T.exportSheet.groupTitle(data.group.name)}
          queryKey={["export-group", String(groupId)]}
          fetchText={() => api.exportGroupText({ group_id: groupId })}
          onClose={() => setShowExport(false)}
        />
      )}

      {confirm === "delete" && (
        <ConfirmSheet
          title={T.group.deleteConfirmTitle}
          body={T.group.deleteConfirmBody}
          confirmLabel={T.common.deleteConfirm}
          busy={del.isPending}
          onCancel={() => setConfirm(null)}
          onConfirm={() => del.mutate()}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ app

export function App() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>({ kind: "home" });
  // 一覧へ戻るたびに最新の状態を取り直す（設計書 v1.8 / 4.8章）。
  // 並び替え・未読などの表示が、手動更新なしで常に最新になるようにする。
  const goHome = () => {
    queryClient.invalidateQueries({ queryKey: ["home"] });
    setView({ kind: "home" });
  };
  return (
    <div className="min-h-screen" style={{ background: "var(--bg)", color: "var(--text)" }}>
      {view.kind === "home" && (
        <>
          <SafeAreaTopScrim backgroundColor="var(--bg)" />
          <HomeView go={setView} />
        </>
      )}
      {view.kind === "chat" && <ChatView characterId={view.characterId} unreadFromSeq={view.unreadFromSeq} back={goHome} />}
      {view.kind === "group" && <GroupView groupId={view.groupId} unreadFromSeq={view.unreadFromSeq} back={goHome} />}
      {view.kind === "logs" && (
        <>
          <SafeAreaTopScrim backgroundColor="var(--bg)" />
          <LogsView back={goHome} />
        </>
      )}
    </div>
  );
}
