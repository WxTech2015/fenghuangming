"""Pinned musicdl 2.14.0 adapter. JSONL RPC, no interactive CLI or audio downloads.

Known song IDs use the platform client's ID resolvers. Only the separate search
operation performs a title/artist search; Node verifies every candidate first.
"""
import contextlib
import io
import json
import os
import re
import sys
import traceback

PROTOCOL_OUT = sys.stdout
CLIENTS = {}
NAMES = {"netease": "NeteaseMusicClient", "qq": "QQMusicClient", "kugou": "KugouMusicClient", "kuwo": "KuwoMusicClient", "migu": "MiguMusicClient", "bodian": "BodianMusicClient"}


def emit(message):
    PROTOCOL_OUT.write(json.dumps(message, ensure_ascii=False) + "\n")
    PROTOCOL_OUT.flush()


def error_detail(error):
    return {"name": type(error).__name__, "message": str(error)[:2000], "stack": traceback.format_exc(limit=8)[-8000:]}


class LogBuffer(io.StringIO):
    def __init__(self):
        super().__init__()
        self.too_long = False

    def write(self, text):
        if self.tell() + len(text) > 8000:
            self.too_long = True
        if not self.too_long:
            super().write(text)
        return len(text)


def report_output(stdout, stderr):
    for name, output in (("stdout", stdout), ("stderr", stderr)):
        text = "[超长输出已省略]" if output.too_long else output.getvalue()
        if text.strip():
            emit({"type": "debug", "event": "musicdl.library." + name, "message": "musicdl 库输出", "output": text})


def client_for(platform):
    if platform not in NAMES:
        raise ValueError("musicdl 不支持此平台")
    if platform not in CLIENTS:
        from musicdl import musicdl
        name = NAMES[platform]
        cookie_text = os.environ.get("NETEASE_COOKIE" if platform == "netease" else "QQ_MUSIC_COOKIE" if platform == "qq" else "", "")
        cookies = dict(pair.strip().split("=", 1) for pair in cookie_text.split(";") if "=" in pair)
        cfg = {"disable_print": True, "auto_set_proxies": False, "random_update_ua": False, "max_retries": 1, "maintain_session": False, "search_size_per_source": 5, "search_size_per_page": 5, "work_dir": os.path.join(os.getcwd(), "outputs"), "default_parse_cookies": cookies, "default_search_cookies": cookies, "default_download_cookies": cookies}
        instance = musicdl.MusicClient(music_sources=[name], init_music_clients_cfg={name: cfg})
        CLIENTS[platform] = instance.music_clients[name]
    return CLIENTS[platform]


def external_id(song, platform):
    raw = (getattr(song, "raw_data", None) or {}).get("search", {})
    if platform == "migu":
        return str(raw.get("copyrightId") or song.identifier or "")
    return str(song.identifier or "")


def as_track(song, original):
    result = dict(original)
    result.pop("originalAudioUrl", None)
    result.update(externalId=external_id(song, original["platform"]), title=str(song.song_name or ""), artists=[x.strip() for x in re.split(r"[,，/／]", str(song.singers or "")) if x.strip()][:10], album=str(song.album or ""), durationSeconds=float(song.duration_s or 0), coverUrl=str(song.cover_url or ""), lyrics=str(song.lyric or "")[:30000])
    return result


def source(song, platform):
    if not song or not isinstance(song.download_url, str) or not song.download_url.startswith(("http://", "https://")) or song.protocol != "HTTP":
        raise ValueError("musicdl 未取得可下载的完整音频")
    headers = {str(k): str(v) for k, v in (song.default_download_headers or {}).items() if str(k).lower() in {"referer", "user-agent", "origin", "cookie"}}
    if song.default_download_cookies:
        headers["Cookie"] = "; ".join(str(k) + "=" + str(v) for k, v in song.default_download_cookies.items())
    return {"url": song.download_url, "headers": headers, "source": "musicdl"}


def resolve_exact(track, client):
    platform, song_id = track["platform"], track.get("externalId", "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", song_id):
        raise ValueError("musicdl 需要原歌曲 ID")
    overrides = {"timeout": 8, "headers": client.default_parse_headers, "cookies": client.default_parse_cookies}
    seeds = {"netease": {"id": song_id}, "qq": {"mid": song_id, "songmid": song_id}, "kugou": {"hash": song_id, "FileHash": song_id}, "kuwo": {"MUSICRID": "MUSIC_" + song_id}, "bodian": {"id": song_id}}
    if platform == "migu":
        # musicdl needs both copyrightId and contentId. Query the platform with
        # the supplied ID, then require an exact ID match before URL resolution.
        seed = None
        for url in client._constructsearchurls(keyword=song_id):
            response = client.get(url, **overrides)
            response.raise_for_status()
            for candidate in response.json().get("songResultData", {}).get("result", []):
                if song_id in {str(candidate.get("copyrightId", "")), str(candidate.get("contentId", ""))}:
                    seed = candidate
                    break
            if seed:
                break
        if not seed:
            raise ValueError("musicdl 无法按原咪咕 ID 获取歌曲资料")
    else:
        seed = seeds[platform]
    song = None
    third_party = getattr(client, "_parsewiththirdpartapis", None)
    # Follow musicdl's cookie-free workflow: try its alternate resolvers before
    # accepting the guest official endpoint, which may contain only a preview.
    if not overrides.get("cookies") and third_party:
        try:
            song = third_party(search_result=seed, request_overrides=overrides)
        except Exception as error:
            emit({"type": "debug", "event": "musicdl.alternate.failed", "message": "musicdl 备用接口取源失败", "error": error_detail(error)})
    if not song or not song.with_valid_download_url:
        try:
            song = client._parsewithofficialapiv1(search_result=seed, lossless_quality_is_sufficient=False, request_overrides=overrides)
        except Exception as error:
            emit({"type": "debug", "event": "musicdl.official.failed", "message": "musicdl 官方接口取源失败", "error": error_detail(error)})
    if not song:
        raise ValueError("musicdl 原歌曲取源失败")
    actual_id = external_id(song, platform)
    raw = (song.raw_data or {}).get("search", {})
    aliases = {actual_id.lower(), str(raw.get("copyrightId", "")).lower(), str(raw.get("contentId", "")).lower()}
    if song_id.lower() not in aliases:
        raise ValueError("musicdl 返回的歌曲与分享 ID 不一致")
    return source(song, platform)


def handle(method, track):
    client = client_for(track["platform"])
    if method == "resolve":
        return resolve_exact(track, client)
    if method == "search":
        songs = client.search(track["title"] + " " + " ".join(track.get("artists", [])), num_threadings=1, request_overrides={"timeout": 8})
        return [as_track(song, track) for song in songs[:5]]
    raise ValueError("未知音源操作")


init_stdout, init_stderr = LogBuffer(), LogBuffer()
try:
    with contextlib.redirect_stdout(init_stdout), contextlib.redirect_stderr(init_stderr):
        import platformdirs
        platformdirs.user_log_dir = lambda *args, **kwargs: os.environ["QQMUSIC_MUSICDL_LOG_DIR"]
        import musicdl as package
        from musicdl import musicdl
        if package.__version__ != "2.14.0":
            raise RuntimeError("musicdl 版本不一致")
    report_output(init_stdout, init_stderr)
    emit({"type": "ready"})
except Exception as error:
    report_output(init_stdout, init_stderr)
    emit({"type": "failed", "error": error_detail(error)})
    sys.exit(1)

while True:
    line = sys.stdin.readline(1024 * 1024 + 1)
    if not line:
        break
    if len(line) > 1024 * 1024:
        sys.exit(2)
    request = {}
    call_stdout, call_stderr = LogBuffer(), LogBuffer()
    try:
        request = json.loads(line)
        with contextlib.redirect_stdout(call_stdout), contextlib.redirect_stderr(call_stderr):
            result = handle(request["method"], request["track"])
        report_output(call_stdout, call_stderr)
        emit({"type": "result", "id": request["id"], "result": result})
    except Exception as error:
        report_output(call_stdout, call_stderr)
        emit({"type": "result", "id": request.get("id"), "error": error_detail(error)})
