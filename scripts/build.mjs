// 앨범 사이트 만들기: albums/ 폴더를 읽어 사진을 줄이고(_site/media) 목록(albums.json)을 만든다.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";

const SRC = "albums", OUT = "_site", MEDIA = path.join(OUT, "media");
const IMG = /\.(jpe?g|png|webp|avif|tiff?)$/i, GIF = /\.gif$/i, VID = /\.(mp4|webm|mov|m4v)$/i;
const MEMO = /^(메모|memo|설명|note|readme)\.(txt|md)$/i;
const YT = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/))([\w-]{11})/;
const GD = /drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:.*&)?id=)([\w-]{20,80})/;
const CACHE = ".cache/video";
const HAS_FFMPEG = spawnSync("ffmpeg", ["-version"]).status === 0;
const DATE = /^(\d{4})[-.](\d{1,2})[-.](\d{1,2})[\s_-]*(.*)$/;
const nfc = s => s.normalize("NFC");
const byName = (a, b) => a.localeCompare(b, "ko", { numeric: true });
const hash = s => crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);
const warn = [];

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

async function album(dir, name) {
  const m = DATE.exec(nfc(name));
  const date = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  const title = m[4].trim() || "활동";
  const files = (await fs.readdir(dir, { withFileTypes: true })).filter(f => f.isFile()).map(f => f.name).sort(byName);
  const media = [];
  let note = "";
  for (const f of files) {
    const full = path.join(dir, f), id = hash(path.relative(SRC, full));
    if (MEMO.test(nfc(f))) {
      const text = await fs.readFile(full, "utf8");
      const keep = [];
      for (const line of text.split(/\r?\n/)) {
        const y = YT.exec(line);
        const g = GD.exec(line);
        if (y) media.push({ kind: "youtube", yt: y[1] });
        else if (g) media.push({ kind: "drive", gd: g[1] });
        else keep.push(line);
      }
      note = keep.join("\n").trim();
    } else if (IMG.test(f)) {
      try {
        const big = `media/${id}.jpg`, small = `media/${id}_t.jpg`;
        const img = sharp(full, { failOn: "none" }).rotate();
        await img.clone().resize({ width: 1920, height: 1920, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }).toFile(path.join(OUT, big));
        await img.clone().resize({ width: 720, height: 720, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 76, mozjpeg: true }).toFile(path.join(OUT, small));
        media.push({ kind: "image", src: big, thumb: small });
      } catch (e) { warn.push(`사진을 읽지 못해 건너뜀: ${name}/${f} (${e.message})`); }
    } else if (GIF.test(f)) {
      const out = `media/${id}.gif`;
      await fs.copyFile(full, path.join(OUT, out));
      media.push({ kind: "image", src: out, thumb: out });
    } else if (VID.test(f)) {
      media.push(await video(full, id, `${name}/${f}`));
    } else if (/\.(heic|heif)$/i.test(f)) {
      warn.push(`아이폰 HEIC 사진은 웹에서 보이지 않아 건너뜀: ${name}/${f} → JPG로 바꿔 올려 주세요`);
    }
  }
  return { date, title, note, media };
}

// 영상: 웹에서 잘 재생되는 MP4(최대 1280px, H.264/AAC)로 줄이고 표지 그림을 만든다. 한 번 줄인 영상은 캐시에 보관.
function fileHash(p) {
  return new Promise((res, rej) => { const h = crypto.createHash("sha1"); createReadStream(p).on("data", d => h.update(d)).on("end", () => res(h.digest("hex").slice(0, 16))).on("error", rej); });
}
async function video(full, id, label) {
  const ext = path.extname(full).toLowerCase();
  if (!HAS_FFMPEG) {
    const out = `media/${id}${ext}`; await fs.copyFile(full, path.join(OUT, out));
    warn.push(`ffmpeg가 없어 영상을 줄이지 않고 그대로 올림: ${label}`);
    return { kind: "video", src: out };
  }
  const h = await fileHash(full), cv = path.join(CACHE, h + ".mp4"), cp = path.join(CACHE, h + ".jpg");
  if (!(await exists(cv)) || !(await exists(cp))) {
    await fs.mkdir(CACHE, { recursive: true });
    const scale = "scale='if(gte(iw,ih),trunc(min(1280,iw)/2)*2,-2)':'if(gte(iw,ih),-2,trunc(min(1280,ih)/2)*2)'";
    const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", full, "-vf", scale, "-c:v", "libx264", "-preset", "veryfast", "-crf", "25",
      "-maxrate", "4M", "-bufsize", "8M", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-movflags", "+faststart", cv + ".tmp.mp4"]);
    if (r.status !== 0) {
      warn.push(`영상을 변환하지 못해 원본을 그대로 올림: ${label} (${String(r.stderr).slice(0, 200)})`);
      const out = `media/${id}${ext}`; await fs.copyFile(full, path.join(OUT, out)); return { kind: "video", src: out };
    }
    await fs.rename(cv + ".tmp.mp4", cv);
    let p = spawnSync("ffmpeg", ["-v", "error", "-y", "-ss", "1", "-i", cv, "-frames:v", "1", "-vf", "scale='min(720,iw)':-2", "-q:v", "4", cp]);
    if (p.status !== 0 || !(await exists(cp))) spawnSync("ffmpeg", ["-v", "error", "-y", "-i", cv, "-frames:v", "1", "-vf", "scale='min(720,iw)':-2", "-q:v", "4", cp]);
    const a = (await fs.stat(full)).size, b = (await fs.stat(cv)).size;
    console.log(`영상 변환: ${label} ${(a / 1048576).toFixed(1)}MB → ${(b / 1048576).toFixed(1)}MB`);
  }
  const src = `media/${id}.mp4`, poster = `media/${id}_p.jpg`;
  await fs.copyFile(cv, path.join(OUT, src));
  if (await exists(cp)) { await fs.copyFile(cp, path.join(OUT, poster)); return { kind: "video", src, poster }; }
  return { kind: "video", src };
}

async function walk(dir, albums) {
  if (!(await exists(dir))) return;
  for (const e of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => byName(a.name, b.name))) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (DATE.test(nfc(e.name))) albums.push(await album(full, e.name));
    else await walk(full, albums); // 예: albums/2026-11/ 처럼 월별로 묶은 폴더
  }
}

await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(MEDIA, { recursive: true });
const albums = [];
await walk(SRC, albums);
albums.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

let site = { name: "우리 동호회", sub: "" };
try { site = { ...site, ...JSON.parse(await fs.readFile("site.json", "utf8")) }; } catch { warn.push("site.json을 읽지 못해 기본 이름을 씀"); }
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const html = (await fs.readFile("index.html", "utf8")).replaceAll("__CLUB_NAME__", esc(site.name)).replaceAll("__CLUB_SUB__", esc(site.sub));
await fs.writeFile(path.join(OUT, "index.html"), html);
// 배경음악: music/ 폴더의 음악 파일(추억영상 만들기에서 고를 수 있음)
const music = [];
if (await exists("music")) {
  await fs.mkdir(path.join(OUT, "music"), { recursive: true });
  for (const f of (await fs.readdir("music")).sort(byName)) {
    if (!/\.(mp3|m4a|aac|ogg|oga|wav)$/i.test(f)) continue;
    const out = `music/${hash("music/" + f)}${path.extname(f).toLowerCase()}`;
    await fs.copyFile(path.join("music", f), path.join(OUT, out));
    music.push({ name: nfc(f).replace(/\.[^.]+$/, ""), src: out });
  }
}
await fs.writeFile(path.join(OUT, "albums.json"), JSON.stringify({ generated: new Date().toISOString(), albums, music }));
await fs.writeFile(path.join(OUT, ".nojekyll"), "");

const n = albums.reduce((s, a) => s + a.media.length, 0);
console.log(`완료: 활동 ${albums.length}개, 사진·영상 ${n}개, 배경음악 ${music.length}곡`);
for (const w of warn) console.log("⚠ " + w);
