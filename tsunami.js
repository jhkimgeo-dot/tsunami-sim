/* 쓰나미 침수 시뮬레이션 v6 (시작점·도심 지점 수정 가능, 도심 침투, 바닷물 색 - 여러 지점으로 구역 지정, 넓은 구역 분할 높이 읽기) - 3dview.sistech3d.com 뷰어 주입 스크립트
 * 1) 3D 도시 모델(지형+건물)을 위에서 내려다본 깊이 정보로 높이 격자를 만든다.
 * 2) 그 격자 위에서 천수 방정식(유한체적법, HLL 플럭스 + 정수압 재구성)을 풀어
 *    건물에 막히고 도로를 따라 흐르는 물의 흐름을 계산한다.
 * 3) 쓰나미 진행 방향(방위각) 설정, 실감 표시 + 침수 깊이/최대 침수/도달 시간/유속/지형 결과 표시,
 *    흐름 입자, 지점 측정, 결과 요약.
 * 전역 이름은 __tsunami* 만 사용.
 */
(async () => {
  let PREV = null;
  if (window.__tsunami) {
    try { const o = window.__tsunami, st = o.state; if (st && !st.computing && st.A) PREV = { grid: o.grid, cap: o.cap, state: Object.assign({}, st) }; } catch (e) {}
    try { window.__tsunami.destroy(); } catch (e) {}
  }

  // ---------- 뷰어 확보 ----------
  function findViewer() {
    if (window.__tsunamiViewer && window.__tsunamiViewer.scene) return window.__tsunamiViewer;
    let node = document.querySelector('.cesium-widget canvas') || document.querySelector('.cesium-widget');
    while (node) {
      const fk = Object.keys(node).find(k => k.startsWith('__reactFiber'));
      if (fk) {
        let f = node[fk], d = 0;
        while (f && d < 80) {
          const mp = f.memoizedProps;
          if (mp && mp.value && mp.value.viewer && mp.value.viewer.scene) return mp.value.viewer;
          let hs = f.memoizedState, i = 0;
          while (hs && i < 40) {
            const v = hs.memoizedState; const c = v && (v.current ?? v);
            if (c && c.scene && c.camera && c.entities) return c;
            hs = hs.next; i++;
          }
          f = f.return; d++;
        }
      }
      node = node.parentElement;
    }
    return null;
  }
  const viewer = findViewer();
  if (!viewer) { alert('3D 뷰어를 찾지 못했습니다. 프로젝트를 먼저 불러온 뒤 다시 실행하세요.'); return; }
  const scene = viewer.scene, camera = viewer.camera, canvas = scene.canvas;
  const ellipsoid = scene.globe.ellipsoid;
  const DEG = Math.PI / 180;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---------- Cesium 클래스 확보 ----------
  const C3 = camera.position.constructor;
  const Color = scene.backgroundColor.constructor;
  const Matrix4 = camera.transform.constructor;
  const sampleCmd = await new Promise(res => {
    const rm = scene.postRender.addEventListener(() => {
      const c = scene.frameState.commandList.find(c => c.shaderProgram && c.vertexArray && c.renderState);
      if (c) { rm(); res(c); }
    });
    scene.requestRender();
  });
  const DrawCommand = sampleCmd.constructor;
  const ShaderProgram = sampleCmd.shaderProgram.constructor;
  const VertexArray = sampleCmd.vertexArray.constructor;
  const RenderState = sampleCmd.renderState.constructor;
  let BoundingSphere = null;
  for (let i = 0; i < scene.primitives.length; i++) { const p = scene.primitives.get(i); if (p && p.boundingSphere) { BoundingSphere = p.boundingSphere.constructor; break; } }
  const PASS_TRANSLUCENT = 9;

  // ---------- 상태 ----------
  const S = {
    mode: 'idle', A: null, pts: [],
    bearing: 0, H: 6, D: 15, W: 800, extra: 300, seaPad: 200, dur: 180, baseAdj: 0, baseAuto: 0, prec: 'normal',
    speedMul: 5, view: 'real', particles: true, guide: true,
    t: 0, tEnd: 0, tReached: 0, running: false, computing: false, done: false, dead: false,
    raf: 0, lastTs: 0, probes: [], helpers: [], dirty: true, lastRenderT: -1, lastUp: null, bearingManual: false,
  };
  const PREC = { fast: { nmax: 35000, label: '빠름' }, normal: { nmax: 70000, label: '보통' }, fine: { nmax: 140000, label: '정밀' } };
  let CAP = null;   // 지형·건물 높이 수집 결과
  let G = null;     // 계산 격자 + 상태

  // ---------- 좌표계 ----------
  function makeFrame(lon, lat, h, dirE, dirN) {
    const lo = lon * DEG, la = lat * DEG;
    const east = [-Math.sin(lo), Math.cos(lo), 0];
    const north = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)];
    const up = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
    const X = east.map((v, i) => dirE * v + dirN * north[i]);
    const Y = east.map((v, i) => -dirN * v + dirE * north[i]);
    const o = C3.fromDegrees(lon, lat, h);
    const m = Matrix4.fromColumnMajorArray([X[0], X[1], X[2], 0, Y[0], Y[1], Y[2], 0, up[0], up[1], up[2], 0, o.x, o.y, o.z, 1]);
    return { X, Y, Z: up, o, m };
  }
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const toLocal = (F, c) => { const d = [c.x - F.o.x, c.y - F.o.y, c.z - F.o.z]; return [dot3(F.X, d), dot3(F.Y, d), dot3(F.Z, d)]; };
  const rotLocal = (F, v) => { const d = [v.x, v.y, v.z]; return [dot3(F.X, d), dot3(F.Y, d), dot3(F.Z, d)]; };
  const toWorld = (F, x, y, z) => new C3(F.o.x + F.X[0] * x + F.Y[0] * y + F.Z[0] * z, F.o.y + F.X[1] * x + F.Y[1] * y + F.Z[1] * z, F.o.z + F.X[2] * x + F.Y[2] * y + F.Z[2] * z);
  const dirWorld = (F, x, y, z) => new C3(F.X[0] * x + F.Y[0] * y + F.Z[0] * z, F.X[1] * x + F.Y[1] * y + F.Z[1] * z, F.X[2] * x + F.Y[2] * y + F.Z[2] * z);
  const mPerDegLat = lat => 111132.92 - 559.82 * Math.cos(2 * lat * DEG);
  const mPerDegLon = lat => 111412.84 * Math.cos(lat * DEG) - 93.5 * Math.cos(3 * lat * DEG);
  function pickAt(x, y) {
    let c;
    const wp = { x, y, toString() { return x + ',' + y; } };
    try { if (scene.pickPositionSupported) c = scene.pickPosition(wp); } catch (e) {}
    if (!c) { try { c = scene.globe.pick(camera.getPickRay(wp), scene); } catch (e) {} }
    if (!c) return null;
    const cg = ellipsoid.cartesianToCartographic(c);
    return cg ? { lon: cg.longitude / DEG, lat: cg.latitude / DEG, h: cg.height, c } : null;
  }
  // 구역 기하: 바다 시작점 A에서 진행 방향(x)으로, 지정한 도심 지점을 모두 덮는 직사각형
  function geom() {
    if (!S.A || !S.pts.length) return null;
    const lonA = S.A.lon, latA = S.A.lat, mx = mPerDegLon(latA), my = mPerDegLat(latA);
    const kx = Math.sin(S.bearing * DEG), ky = Math.cos(S.bearing * DEG);
    let xmax = 0, ymin = 0, ymax = 0;
    for (const p of S.pts) {
      const E = (p.lon - lonA) * mx, N = (p.lat - latA) * my;
      const x = E * kx + N * ky, y = -E * ky + N * kx;
      if (x > xmax) xmax = x; if (y < ymin) ymin = y; if (y > ymax) ymax = y;
    }
    const x0 = -S.seaPad, x1 = Math.max(xmax + S.extra, 300);
    const Lx = Math.min(8000, x1 - x0), xc = x0 + Lx / 2;
    const yc = (ymin + ymax) / 2, Wy = Math.min(6000, Math.max(S.W, ymax - ymin + 300));
    const Ec = xc * kx - yc * ky, Nc = xc * ky + yc * kx;
    const lon0 = lonA + Ec / mx, lat0 = latA + Nc / my;
    const seaH = S.A.h + S.baseAuto + S.baseAdj;
    return { lon0, lat0, Lx, Wy, kx, ky, seaH, xmax, F: makeFrame(lon0, lat0, seaH, kx, ky) };
  }
  const cellSizeFor = g => Math.max(3, Math.sqrt(g.Lx * g.Wy / PREC[S.prec].nmax));
  const capCellFor = g => Math.min(4, Math.max(1.5, cellSizeFor(g) / 2));
  const compass = b => ['북', '북북동', '북동', '동북동', '동', '동남동', '남동', '남남동', '남', '남남서', '남서', '서남서', '서', '서북서', '북서', '북북서'][Math.round(((b % 360) + 360) % 360 / 22.5) % 16];

  // ---------- 1) 지형·건물 높이 수집 ----------
  const isTileset = p => p && typeof p.maximumScreenSpaceError === 'number' && 'tilesLoaded' in p;
  function hasTileset(p) {
    if (isTileset(p)) return true;
    if (p && typeof p.length === 'number' && typeof p.get === 'function') { for (let i = 0; i < p.length; i++) if (hasTileset(p.get(i))) return true; }
    return false;
  }
  function allTilesets(p = scene.primitives, out = []) {
    if (isTileset(p)) out.push(p);
    else if (p && typeof p.length === 'number' && typeof p.get === 'function') for (let i = 0; i < p.length; i++) allTilesets(p.get(i), out);
    return out;
  }
  const RE = 6371000;
  async function waitTiles(tsets, prog) {
    let okFrames = 0;
    const rm = scene.postRender.addEventListener(() => { okFrames = tsets.every(t => t.tilesLoaded) ? okFrames + 1 : 0; });
    const t0 = performance.now();
    try {
      while (performance.now() - t0 < 45000) {
        await sleep(250); scene.requestRender();
        prog(Math.min(0.95, (performance.now() - t0) / 15000));
        if (okFrames >= 3 && performance.now() - t0 > 1200) break;
      }
    } finally { rm(); }
  }
  function readDepth(Fc) {
    return new Promise((res, rej) => {
      const rm2 = scene.postRender.addEventListener(() => {
        rm2();
        try {
          const view = scene._view || scene.view, ctx = scene.context;
          const W = scene.drawingBufferWidth, H = scene.drawingBufferHeight;
          const fl = view.frustumCommandsList.map((f, i) => ({ near: f.near, far: f.far, px: ctx.readPixels({ x: 0, y: 0, width: W, height: H, framebuffer: view.pickDepths[i].framebuffer }) }));
          const fr = camera.frustum, ar = fr.aspectRatio, fy = ar <= 1 ? fr.fov : 2 * Math.atan(Math.tan(fr.fov / 2) / ar);
          res({ W, H, fl, ty: Math.tan(fy / 2), tx: Math.tan(fy / 2) * ar, P: toLocal(Fc, camera.positionWC), R: rotLocal(Fc, camera.rightWC), U: rotLocal(Fc, camera.upWC), D: rotLocal(Fc, camera.directionWC) });
        } catch (e) { rej(e); }
      });
      scene.requestRender();
    });
  }
  // 깊이 -> 지역 좌표 -> 칸별 최고 높이 (지구 곡률 보정 포함)
  function accumulate(raw, z, Emin, Nmin, cell, nE, nN) {
    const { W, H, fl, tx, ty, P, R, U, D } = raw;
    let valid = 0;
    for (let y = 0; y < H; y++) {
      const ny = ((y + 0.5) / H) * 2 - 1;
      for (let x = 0; x < W; x++) {
        const i4 = (y * W + x) * 4;
        let zz = -1;
        for (let f = 0; f < fl.length; f++) {
          const px = fl[f].px;
          const d = px[i4] / 255 + px[i4 + 1] / 65025 + px[i4 + 2] / 16581375 + px[i4 + 3] / 4228250625;
          if (d > 0 && d < 1) { const L2 = Math.log2(fl[f].far - fl[f].near + 1); zz = Math.pow(2, d * L2) - 1 + fl[f].near; break; }
        }
        if (zz < 0) continue;
        const nx = ((x + 0.5) / W) * 2 - 1;
        const ex = nx * zz * tx, ey = ny * zz * ty;
        const lx = P[0] + R[0] * ex + U[0] * ey + D[0] * zz, ly = P[1] + R[1] * ex + U[1] * ey + D[1] * zz;
        const lz = P[2] + R[2] * ex + U[2] * ey + D[2] * zz + (lx * lx + ly * ly) / (2 * RE);
        const ci = Math.floor((lx - Emin) / cell), cj = Math.floor((ly - Nmin) / cell);
        if (ci < 0 || cj < 0 || ci >= nE || cj >= nN) continue;
        const k = cj * nE + ci;
        if (lz > z[k]) { if (z[k] < -1e8) valid++; z[k] = lz; }
      }
    }
    return valid;
  }
  async function captureHeights() {
    const g = geom(); if (!g) throw new Error('구역이 없습니다');
    // 구역을 덮는 동·북 방향 사각형 (구역 중심 기준)
    let Emin = 1e9, Emax = -1e9, Nmin = 1e9, Nmax = -1e9;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const x = sx * g.Lx / 2, y = sy * g.Wy / 2, E = x * g.kx - y * g.ky, N = x * g.ky + y * g.kx;
      Emin = Math.min(Emin, E); Emax = Math.max(Emax, E); Nmin = Math.min(Nmin, N); Nmax = Math.max(Nmax, N);
    }
    const M = 60; Emin -= M; Nmin -= M; Emax += M; Nmax += M;
    let capCell = capCellFor(g);
    while (((Emax - Emin) / capCell) * ((Nmax - Nmin) / capCell) > 16e6) capCell *= 1.2;
    const nE = Math.ceil((Emax - Emin) / capCell), nN = Math.ceil((Nmax - Nmin) / capCell);
    const Fc = makeFrame(g.lon0, g.lat0, S.A.h, 1, 0);   // 동·북 축, 원점 높이 = 클릭한 바다 높이
    const sv = {
      pos: C3.clone(camera.positionWC), dir: C3.clone(camera.directionWC), up: C3.clone(camera.upWC), fov: camera.frustum.fov,
      globe: scene.globe.show, fog: scene.fog.enabled, ground: scene.groundPrimitives ? scene.groundPrimitives.show : undefined,
      inputs: scene.screenSpaceCameraController.enableInputs, prims: [], mse: [],
    };
    const tsets = allTilesets();
    if (!tsets.length) throw new Error('3D 모델(타일셋)을 찾지 못했습니다');
    const restore = () => {
      sv.prims.forEach(([p, s]) => { try { p.show = s; } catch (e) {} });
      sv.mse.forEach(([t, v]) => { t.maximumScreenSpaceError = v; });
      scene.globe.show = sv.globe; scene.fog.enabled = sv.fog;
      if (scene.groundPrimitives && sv.ground !== undefined) scene.groundPrimitives.show = sv.ground;
      camera.frustum.fov = sv.fov;
      camera.setView({ destination: sv.pos, orientation: { direction: sv.dir, up: sv.up } });
      scene.screenSpaceCameraController.enableInputs = sv.inputs;
    };
    try {
      scene.screenSpaceCameraController.enableInputs = false;
      for (let i = 0; i < scene.primitives.length; i++) { const p = scene.primitives.get(i); if (!hasTileset(p) && p) { sv.prims.push([p, p.show]); p.show = false; } }
      tsets.forEach(t => { sv.mse.push([t, t.maximumScreenSpaceError]); t.maximumScreenSpaceError = Math.min(t.maximumScreenSpaceError, 3); });
      scene.globe.show = false; scene.fog.enabled = false;
      if (scene.groundPrimitives) scene.groundPrimitives.show = false;
      const aspect = camera.frustum.aspectRatio || (canvas.width / canvas.height);
      const fovy = 20 * DEG;
      camera.frustum.fov = aspect <= 1 ? fovy : 2 * Math.atan(Math.tan(fovy / 2) * aspect);
      // 넓은 구역은 여러 장으로 나눠 읽기 (화면 1픽셀 ≈ 칸 크기의 0.75배)
      const Wpx = scene.drawingBufferWidth, Hpx = scene.drawingBufferHeight;
      const res = capCell * 0.75;
      const tileE = Wpx * res * 0.85, tileN = Hpx * res * 0.85;
      const tE = Math.max(1, Math.ceil((Emax - Emin) / tileE)), tN = Math.max(1, Math.ceil((Nmax - Nmin) / tileN));
      const stepE = (Emax - Emin) / tE, stepN = (Nmax - Nmin) / tN;
      const alt = (Hpx * res) / (2 * Math.tan(fovy / 2));
      const z = new Float32Array(nE * nN).fill(-1e9);
      let valid = 0, ti = 0; const total = tE * tN;
      for (let b = 0; b < tN; b++) for (let a = 0; a < tE; a++) {
        if (S.dead || !S.computing) throw new Error('사용자가 중지했습니다');
        const cE = Emin + (a + 0.5) * stepE, cN = Nmin + (b + 0.5) * stepN;
        camera.setView({ destination: toWorld(Fc, cE, cN, alt), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
        await waitTiles(tsets, f => setProgress((ti + f) / total, `지형·건물 높이 읽는 중… (${ti + 1}/${total}번째 구간, 카메라가 잠시 위로 이동합니다)`));
        valid += accumulate(await readDepth(Fc), z, Emin, Nmin, capCell, nE, nN);
        ti++;
      }
      restore();
      // 건물 뒤에 가려진 빈 칸: 주변 최저값으로 채우기 (도로·지면일 가능성이 큼)
      for (let pass = 0; pass < 12; pass++) {
        let changed = 0; const srcz = z.slice();
        for (let j = 0; j < nN; j++) for (let i = 0; i < nE; i++) {
          const k = j * nE + i; if (srcz[k] > -1e8) continue;
          let m = 1e9;
          for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
            const a2 = i + di, b2 = j + dj; if (a2 < 0 || b2 < 0 || a2 >= nE || b2 >= nN) continue;
            const v = srcz[b2 * nE + a2]; if (v > -1e8 && v < m) m = v;
          }
          if (m < 1e8) { z[k] = m; changed++; }
        }
        if (!changed) break;
      }
      CAP = { nE, nN, cell: capCell, Emin, Emax, Nmin, Nmax, z, Fc, lon0: g.lon0, lat0: g.lat0, Ah: S.A.h, valid, coverage: valid / (nE * nN), tiles: total };
      updateBaseAuto();
      return CAP;
    } catch (e) { try { restore(); } catch (e2) {} throw e; }
  }
  // 시작점 주변(반경 40m) 높이의 중앙값 = 바다 수면
  function updateBaseAuto() {
    if (!CAP || !S.A) return;
    const Al = toLocal(CAP.Fc, S.A.c), vals = [];
    const r = Math.ceil(40 / CAP.cell), ai = Math.floor((Al[0] - CAP.Emin) / CAP.cell), aj = Math.floor((Al[1] - CAP.Nmin) / CAP.cell);
    for (let j = aj - r; j <= aj + r; j++) for (let i = ai - r; i <= ai + r; i++) {
      if (i < 0 || j < 0 || i >= CAP.nE || j >= CAP.nN) continue; const v = CAP.z[j * CAP.nE + i]; if (v > -1e8) vals.push(v);
    }
    vals.sort((p, q) => p - q);
    const med = vals.length ? vals[Math.floor(vals.length / 2)] : S.A.h - CAP.Ah;
    S.baseAuto = CAP.Ah + med - S.A.h;
    S.seaAtA = med;
  }
  function capSample(E, N) {
    const i = Math.floor((E - CAP.Emin) / CAP.cell), j = Math.floor((N - CAP.Nmin) / CAP.cell);
    if (i < 0 || j < 0 || i >= CAP.nE || j >= CAP.nN) return NaN;
    const v = CAP.z[j * CAP.nE + i]; return v > -1e8 ? v : NaN;
  }
  // 이미 읽은 높이 자료가 새 구역을 덮는지 (같은 바다 지점, 충분한 해상도)
  function capCovers(g) {
    if (!CAP) return false;
    if (CAP.cell > capCellFor(g) * 1.6) return false;
    const dE = (g.lon0 - CAP.lon0) * mPerDegLon(CAP.lat0), dN = (g.lat0 - CAP.lat0) * mPerDegLat(CAP.lat0);
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const x = sx * g.Lx / 2, y = sy * g.Wy / 2, E = dE + x * g.kx - y * g.ky, N = dN + x * g.ky + y * g.kx;
      if (E < CAP.Emin || E > CAP.Emax || N < CAP.Nmin || N > CAP.Nmax) return false;
    }
    return true;
  }

  // ---------- 2) 계산 격자 ----------
  const g9 = 9.81, DRY = 1e-4, MANNING = 0.03;
  function buildGrid() {
    const g = geom();
    const cell = Math.max(cellSizeFor(g), CAP.cell);
    const nx = Math.max(20, Math.round(g.Lx / cell)), ny = Math.max(20, Math.round(g.Wy / cell));
    const N = nx * ny, off = S.A.h + S.baseAuto + S.baseAdj - CAP.Ah;
    // 계산 격자(진행 방향 x, 횡방향 y) -> 높이 자료(동·북, 수집 당시 중심 기준)
    const dE = (g.lon0 - CAP.lon0) * mPerDegLon(CAP.lat0), dN = (g.lat0 - CAP.lat0) * mPerDegLat(CAP.lat0);
    const z = new Float64Array(N);
    const r = Math.max(1, Math.round(cell / CAP.cell)), buf = [];
    let missing = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const xc = -g.Lx / 2 + (i + 0.5) * cell, yc = -g.Wy / 2 + (j + 0.5) * cell;
      buf.length = 0;
      for (let b = 0; b < r; b++) for (let a = 0; a < r; a++) {
        const x = xc + ((a + 0.5) / r - 0.5) * cell, y = yc + ((b + 0.5) / r - 0.5) * cell;
        const v = capSample(dE + x * g.kx - y * g.ky, dN + x * g.ky + y * g.kx);
        if (v === v) buf.push(v);
      }
      if (!buf.length) { z[j * nx + i] = NaN; missing++; continue; }
      buf.sort((p, q) => p - q);
      z[j * nx + i] = buf[Math.floor(0.6 * (buf.length - 1))] - off;
    }
    for (let k = 0; k < N; k++) if (z[k] !== z[k]) z[k] = -0.2;
    // 바다 판정: 유입 경계(x=0)와 클릭한 바다 지점에서 이어진 낮은 칸 (내륙의 낮은 곳은 바다로 보지 않음)
    const SEA_T = 0.5;
    const sea = new Uint8Array(N), stack = [];
    const push = k => { if (!sea[k] && z[k] < SEA_T) { sea[k] = 1; stack.push(k); } };
    for (let j = 0; j < ny; j++) push(j * nx);
    const Al = toLocal(g.F, S.A.c);
    const ai = Math.floor((Al[0] + g.Lx / 2) / cell), aj = Math.floor((Al[1] + g.Wy / 2) / cell);
    if (ai >= 0 && aj >= 0 && ai < nx && aj < ny) { const ka = aj * nx + ai; if (z[ka] < SEA_T + 1.5) { z[ka] = Math.min(z[ka], 0); push(ka); } }
    while (stack.length) {
      const k = stack.pop(), i = k % nx, j = (k - i) / nx;
      if (i > 0) push(k - 1); if (i < nx - 1) push(k + 1); if (j > 0) push(k - nx); if (j < ny - 1) push(k + nx);
    }
    // 해저 지형: 해안선에서 멀어질수록 깊게 (경사 1:25, 최대 = 앞바다 수심)
    const dist = new Float32Array(N).fill(1e9);
    for (let k = 0; k < N; k++) if (!sea[k]) dist[k] = 0;
    const D1 = 1, D2 = Math.SQRT2;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i; let d = dist[k];
      if (i > 0) d = Math.min(d, dist[k - 1] + D1);
      if (j > 0) { d = Math.min(d, dist[k - nx] + D1); if (i > 0) d = Math.min(d, dist[k - nx - 1] + D2); if (i < nx - 1) d = Math.min(d, dist[k - nx + 1] + D2); }
      dist[k] = d;
    }
    for (let j = ny - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
      const k = j * nx + i; let d = dist[k];
      if (i < nx - 1) d = Math.min(d, dist[k + 1] + D1);
      if (j < ny - 1) { d = Math.min(d, dist[k + nx] + D1); if (i < nx - 1) d = Math.min(d, dist[k + nx + 1] + D2); if (i > 0) d = Math.min(d, dist[k + nx - 1] + D2); }
      dist[k] = d;
    }
    const allSea = dist.every(v => v > 1e8);
    let seaN = 0;
    for (let k = 0; k < N; k++) if (sea[k]) { seaN++; z[k] = -Math.min(S.D, 0.4 + (allSea ? 1e4 : dist[k] * cell) / 25); }
    let inflowSea = 0, shoreSum = 0;
    for (let j = 0; j < ny; j++) {
      if (sea[j * nx]) inflowSea++;
      let i = 0; while (i < nx && sea[j * nx + i]) i++; shoreSum += i;
    }
    const land = new Uint8Array(N); for (let k = 0; k < N; k++) land[k] = sea[k] ? 0 : 1;
    let zMax = -1e9; for (let k = 0; k < N; k++) if (z[k] > zMax) zMax = z[k];
    G = {
      g, nx, ny, N, cell, z, sea, land, missing, seaN, zMax, inflowFrac: inflowSea / ny,
      h: new Float32Array(N), hu: new Float32Array(N), hv: new Float32Array(N),
      maxH: new Float32Array(N), maxEta: new Float32Array(N), maxS: new Float32Array(N), arr: new Float32Array(N).fill(-1),
      frames: [], tAvail: 0, band: Math.max(6, Math.round(50 / cell)), c0: Math.sqrt(g9 * Math.max(2, S.D)),
      foam: new Float32Array(N), etaPrev: new Float32Array(N),
    };
    // 모의 시간 자동: 바다 건너오는 시간 + 지속 시간 + 내륙으로 번지는 시간(약 2.5m/s)
    const seaLen = shoreSum / ny * cell, landLen = Math.max(0, g.Lx - seaLen);
    S.tEnd = Math.min(3600, seaLen / G.c0 * 1.6 + 12 + S.dur + landLen / 2.5 + 60);
    G.frameDt = Math.max(2, S.tEnd / 160);
    resetDisplay();
    prim.dirty = true;
    return G;
  }
  function resetDisplay() {
    const { N, z, h, hu, hv, sea } = G;
    for (let k = 0; k < N; k++) { h[k] = sea[k] ? Math.max(0, -z[k]) : 0; hu[k] = 0; hv[k] = 0; G.etaPrev[k] = h[k] + z[k]; }
    G.foam.fill(0);
    S.t = 0; S.done = false; S.dirty = true;
  }

  // ---------- 천수 방정식 계산 엔진 (별도 작업 스레드에서 실행, 불가하면 화면 스레드에서) ----------
  function solverMain(ctx) {
    const g9 = 9.81, DRY = 1e-4, MANNING = 0.03, VMAX = 20;
    let F0 = 0, F1 = 0, F2 = 0, CL = 0, CR = 0, stop = false;
    function fluxN(hL, qnL, qtL, zL, hR, qnR, qtR, zR) {
      const zs = zL > zR ? zL : zR;
      let hLs = hL + zL - zs; if (hLs < 0) hLs = 0;
      let hRs = hR + zR - zs; if (hRs < 0) hRs = 0;
      CL = 0.5 * g9 * (hL * hL - hLs * hLs); CR = 0.5 * g9 * (hR * hR - hRs * hRs);
      if (hLs <= DRY && hRs <= DRY) { F0 = 0; F1 = 0; F2 = 0; return; }
      let uL = 0, vL = 0, uR = 0, vR = 0;
      if (hL > 1e-3) { uL = qnL / hL; vL = qtL / hL; }
      if (hR > 1e-3) { uR = qnR / hR; vR = qtR / hR; }
      const cL = Math.sqrt(g9 * hLs), cR = Math.sqrt(g9 * hRs);
      const sL = Math.min(uL - cL, uR - cR), sR = Math.max(uL + cL, uR + cR);
      const fL0 = hLs * uL, fL1 = hLs * uL * uL + 0.5 * g9 * hLs * hLs, fL2 = hLs * uL * vL;
      const fR0 = hRs * uR, fR1 = hRs * uR * uR + 0.5 * g9 * hRs * hRs, fR2 = hRs * uR * vR;
      if (sL >= 0) { F0 = fL0; F1 = fL1; F2 = fL2; }
      else if (sR <= 0) { F0 = fR0; F1 = fR1; F2 = fR2; }
      else {
        const inv = 1 / (sR - sL), ss = sL * sR;
        F0 = (sR * fL0 - sL * fR0 + ss * (hRs - hLs)) * inv;
        F1 = (sR * fL1 - sL * fR1 + ss * (hRs * uR - hLs * uL)) * inv;
        F2 = (sR * fL2 - sL * fR2 + ss * (hRs * vR - hLs * vL)) * inv;
      }
    }
    ctx.onmessage = e => { const m = e.data; if (m.cmd === 'stop') stop = true; else if (m.cmd === 'run') { stop = false; run(m); } };
    function run(m) {
      const { nx, ny, cell: dx, sea, land, band: B, c0, tEnd, frameDt, H, dur } = m;
      const z = Float32Array.from(m.z), N = nx * ny;
      const h = new Float32Array(N), hu = new Float32Array(N), hv = new Float32Array(N);
      const dh = new Float32Array(N), dhu = new Float32Array(N), dhv = new Float32Array(N);
      const maxH = new Float32Array(N), maxS = new Float32Array(N), maxEta = new Float32Array(N), arr = new Float32Array(N).fill(-1);
      const rowHi = new Int32Array(ny), lim = new Int32Array(ny);
      for (let k = 0; k < N; k++) { h[k] = sea[k] ? Math.max(0, -z[k]) : 0; maxEta[k] = h[k] + z[k]; }
      for (let j = 0; j < ny; j++) { let hi = -1; for (let i = nx - 1; i >= 0; i--) if (h[j * nx + i] > DRY) { hi = i; break; } rowHi[j] = hi; }
      const amp = tau => {
        if (tau <= 0) return 0;
        const Tr = 12;
        if (tau < Tr) return H * 0.5 * (1 - Math.cos(Math.PI * tau / Tr));
        if (tau < Tr + dur) return H;
        return H * Math.exp(-(tau - Tr - dur) / 60);
      };
      let t = 0, steps = 0;
      function step() {
        for (let j = 0; j < ny; j++) {
          let mm = rowHi[j]; if (j > 0 && rowHi[j - 1] > mm) mm = rowHi[j - 1]; if (j < ny - 1 && rowHi[j + 1] > mm) mm = rowHi[j + 1];
          lim[j] = Math.min(nx, Math.max(B + 1, mm + 3));
        }
        let amax = 1;
        for (let j = 0; j < ny; j++) {
          const row = j * nx, L = lim[j];
          for (let i = 0; i < L; i++) {
            const k = row + i, hk = h[k]; if (hk <= 1e-3) continue;
            const a = (Math.abs(hu[k]) + Math.abs(hv[k])) / hk + 2 * Math.sqrt(g9 * hk); if (a > amax) amax = a;
          }
        }
        const dt = Math.min(1.0, 0.5 * dx / amax);
        for (let j = 0; j < ny; j++) { const row = j * nx, L = lim[j]; dh.fill(0, row, row + L); dhu.fill(0, row, row + L); dhv.fill(0, row, row + L); }
        for (let j = 0; j < ny; j++) {
          const row = j * nx, L = lim[j];
          for (let i = 0; i <= L; i++) {
            const kL = row + (i > 0 ? i - 1 : 0), kR = row + (i < nx ? i : nx - 1);
            if (h[kL] <= DRY && h[kR] <= DRY) continue;
            // 안쪽 끝 경계: 밖으로 나가는 흐름만 허용 (안으로 들어오려 하면 벽처럼)
            if (i === nx && hu[kL] < 0) fluxN(h[kL], hu[kL], hv[kL], z[kL], h[kL], -hu[kL], hv[kL], z[kL]);
            else fluxN(h[kL], hu[kL], hv[kL], z[kL], h[kR], hu[kR], hv[kR], z[kR]);
            if (i > 0) { dh[kL] -= F0; dhu[kL] -= F1 + CL; dhv[kL] -= F2; }
            if (i < nx && i < L) { dh[kR] += F0; dhu[kR] += F1 + CR; dhv[kR] += F2; }
          }
        }
        for (let j = 0; j <= ny; j++) {
          const L = Math.max(j > 0 ? lim[j - 1] : 0, j < ny ? lim[j] : 0);
          for (let i = 0; i < L; i++) {
            const kB = (j > 0 ? j - 1 : 0) * nx + i, kT = (j < ny ? j : ny - 1) * nx + i;
            if (h[kB] <= DRY && h[kT] <= DRY) continue;
            // 옆 경계: 밖으로 나가는 흐름만 허용
            if (j === 0 && hv[kT] > 0) fluxN(h[kT], -hv[kT], hu[kT], z[kT], h[kT], hv[kT], hu[kT], z[kT]);
            else if (j === ny && hv[kB] < 0) fluxN(h[kB], hv[kB], hu[kB], z[kB], h[kB], -hv[kB], hu[kB], z[kB]);
            else fluxN(h[kB], hv[kB], hu[kB], z[kB], h[kT], hv[kT], hu[kT], z[kT]);
            if (j > 0) { dh[kB] -= F0; dhv[kB] -= F1 + CL; dhu[kB] -= F2; }
            if (j < ny) { dh[kT] += F0; dhv[kT] += F1 + CR; dhu[kT] += F2; }
          }
        }
        const r = dt / dx, t1 = t + dt;
        for (let j = 0; j < ny; j++) {
          const row = j * nx, L = lim[j]; let hi = -1;
          for (let i = 0; i < L; i++) {
            const k = row + i;
            const hk = h[k] + r * dh[k];
            if (hk <= DRY) { h[k] = 0; hu[k] = 0; hv[k] = 0; continue; }
            let qu = hu[k] + r * dhu[k], qv = hv[k] + r * dhv[k];
            const q = Math.sqrt(qu * qu + qv * qv);
            if (q > 0) {
              const hf = hk > 0.01 ? hk : 0.01;
              const fac = 1 / (1 + dt * g9 * MANNING * MANNING * (q / hk) / (hf * Math.cbrt(hf)));
              qu *= fac; qv *= fac;
              const lm = Math.min(VMAX, 4 + 40 * hk) * hk, q2 = q * fac;
              if (q2 > lm) { qu *= lm / q2; qv *= lm / q2; }
            }
            h[k] = hk; hu[k] = qu; hv[k] = qv; hi = i;
          }
          rowHi[j] = hi;
        }
        // 유입 경계(상류 쪽 띠): 입사파로 수렴 (반사파 흡수 겸용)
        for (let j = 0; j < ny; j++) for (let i = 0; i < B; i++) {
          const k = j * nx + i; if (!sea[k] || z[k] > -1.5) continue;
          const w = (1 - i / B) * (1 - i / B);
          const A = amp(t1 - (i * dx) / c0);
          // 들어오는 파(A)와 되돌아 나가는 파를 함께 처리하는 경계 조건: u = (2A - 수위)·√(g/d)
          // 육지가 물로 차면 유입이 멈추고, 파가 약해지면 물이 바다로 빠져나간다
          const d0 = -z[k], eta = h[k] + z[k];
          const uT = (2 * A - eta) * Math.sqrt(g9 / (d0 + Math.max(A, 0)));
          hu[k] += w * (h[k] * uT - hu[k]); hv[k] += w * (0 - hv[k]);
          if (h[k] > DRY && i > rowHi[j]) rowHi[j] = i;
        }
        t = t1; steps++;
        for (let j = 0; j < ny; j++) {
          const row = j * nx, L = lim[j];
          for (let i = 0; i < L; i++) {
            const k = row + i, hk = h[k]; if (hk < 0.02) continue;
            if (hk > maxH[k]) maxH[k] = hk;
            const e = hk + z[k]; if (e > maxEta[k]) maxEta[k] = e;
            if (hk > 0.05) { const s = Math.sqrt(hu[k] * hu[k] + hv[k] * hv[k]) / hk; if (s > maxS[k]) maxS[k] = s; }
            if (land[k] && arr[k] < 0 && hk > 0.1) arr[k] = t1;
          }
        }
      }
      // 재생용 장면 저장 (깊이 cm, 유속 cm/s 정수로 압축)
      function frame() {
        const fh = new Uint16Array(N), fu = new Int16Array(N), fv = new Int16Array(N);
        for (let k = 0; k < N; k++) {
          const hk = h[k]; if (hk <= 0) continue;
          fh[k] = Math.min(65535, Math.round(hk * 100));
          if (hk > 1e-3) { fu[k] = Math.max(-32000, Math.min(32000, Math.round(hu[k] / hk * 100))); fv[k] = Math.max(-32000, Math.min(32000, Math.round(hv[k] / hk * 100))); }
        }
        ctx.postMessage({ type: 'frame', t, h: fh, u: fu, v: fv }, [fh.buffer, fu.buffer, fv.buffer]);
      }
      let nextFrame = frameDt;
      frame();
      const t0 = Date.now();
      function finish(stopped) {
        frame();
        ctx.postMessage({ type: 'done', stopped, t, steps, ms: Date.now() - t0, maxH, maxS, maxEta, arr });
      }
      function chunk() {
        if (stop) { finish(true); return; }
        const c = Date.now();
        while (Date.now() - c < 200 && t < tEnd) {
          step();
          if (t >= nextFrame) { frame(); nextFrame += frameDt; }
          if (!(t === t)) { ctx.postMessage({ type: 'error', msg: '계산이 불안정해졌습니다' }); return; }
        }
        const ph = h.slice(), pu = hu.slice(), pv = hv.slice(), pm = maxH.slice(), pa = arr.slice();
        ctx.postMessage({ type: 'progress', t, steps, h: ph, hu: pu, hv: pv, maxH: pm, arr: pa }, [ph.buffer, pu.buffer, pv.buffer, pm.buffer, pa.buffer]);
        if (t >= tEnd) finish(false); else setTimeout(chunk, 0);
      }
      setTimeout(chunk, 0);
    }
  }
  let worker = null, workerURL = null;
  function startSolver(onMsg) {
    if (worker) { try { worker.terminate(); } catch (e) {} worker = null; }
    try {
      if (!workerURL) workerURL = URL.createObjectURL(new Blob(['(' + solverMain.toString() + ')(self);'], { type: 'text/javascript' }));
      worker = new Worker(workerURL);
      worker.onmessage = e => onMsg(e.data);
      worker.onerror = e => onMsg({ type: 'error', msg: e.message || '작업 스레드 오류' });
      return { send: (m, tr) => worker.postMessage(m, tr || []), kind: 'worker' };
    } catch (e) {
      // 작업 스레드를 쓸 수 없으면 화면 스레드에서 실행
      const ctx = { postMessage: m => setTimeout(() => onMsg(m), 0), onmessage: null };
      solverMain(ctx);
      return { send: m => ctx.onmessage({ data: m }), kind: 'main' };
    }
  }
  let solver = null;

  // 저장된 장면 사이를 보간해서 원하는 시각의 물 상태를 만든다
  function applyTime(t) {
    const Fr = G && G.frames; if (!Fr || !Fr.length) return;
    t = Math.max(0, Math.min(G.tAvail, t));
    let lo = 0, hi = Fr.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (Fr[mid].t <= t) lo = mid; else hi = mid - 1; }
    const a = Fr[lo], b = Fr[Math.min(lo + 1, Fr.length - 1)];
    const w = b.t > a.t ? Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t))) : 0;
    const { N, h, hu, hv } = G;
    for (let k = 0; k < N; k++) {
      const hh = (a.h[k] + (b.h[k] - a.h[k]) * w) * 0.01;
      if (hh <= 0) { h[k] = 0; hu[k] = 0; hv[k] = 0; continue; }
      h[k] = hh; hu[k] = hh * (a.u[k] + (b.u[k] - a.u[k]) * w) * 0.01; hv[k] = hh * (a.v[k] + (b.v[k] - a.v[k]) * w) * 0.01;
    }
    S.t = t; S.dirty = true;
  }
  function seek(target) {
    if (!G || !G.frames.length) return;
    applyTime(target);
    G.foam.fill(0);
    for (let k = 0; k < G.N; k++) G.etaPrev[k] = G.h[k] + G.z[k];
    S.lastRenderT = -1;
  }

  // ---------- 3) 표시용 정점 자료 ----------
  let R = null; // { pos, dyn, aux, res, part }
  const NP = 2200, TRAIL = 6;
  const P = { x: new Float32Array(NP), y: new Float32Array(NP), age: new Float32Array(NP), life: new Float32Array(NP) };
  function viewCode() { return { real: 0, depth: 1, max: 2, arrival: 3, speed: 4, terrain: 5 }[S.view] || 0; }
  function refreshRender(dtSim) {
    if (!G) return;
    const { nx, ny, N, z, h, hu, hv, land, cell } = G;
    if (!R || R.N !== N) {
      R = { N, eta: new Float32Array(N), hr: new Float32Array(N), dyn: new Float32Array(N * 4), aux: new Float32Array(N * 4), res: new Float32Array(N * 2), part: new Float32Array(NP * TRAIL * 4) };
    }
    const mode = S.view, eta = R.eta, hr = R.hr;
    const useMax = mode === 'max';
    // 1차: 젖은 칸의 수면
    for (let k = 0; k < N; k++) {
      if (mode === 'terrain') { eta[k] = z[k] + 0.6; hr[k] = 1; continue; }
      const hk = useMax ? G.maxH[k] : h[k];
      if (hk > 0.02) { eta[k] = z[k] + hk; hr[k] = hk; } else { eta[k] = NaN; hr[k] = 0; }
    }
    // 2차: 마른 칸은 이웃 수면을 이어받음 (벽·높은 땅이면 수면이 모델에 닿아 자연스러운 물가선)
    if (mode !== 'terrain') for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i; if (eta[k] === eta[k]) continue;
      let s = 0, c = 0, hh = 0;
      if (i > 0 && eta[k - 1] === eta[k - 1]) { s += eta[k - 1]; hh += hr[k - 1]; c++; }
      if (i < nx - 1 && eta[k + 1] === eta[k + 1]) { s += eta[k + 1]; hh += hr[k + 1]; c++; }
      if (j > 0 && eta[k - nx] === eta[k - nx]) { s += eta[k - nx]; hh += hr[k - nx]; c++; }
      if (j < ny - 1 && eta[k + nx] === eta[k + nx]) { s += eta[k + nx]; hh += hr[k + nx]; c++; }
      if (c) { const e = s / c; R.dyn[k * 4] = e; R.dyn[k * 4 + 1] = z[k] >= e - 0.05 ? hh / c : 0; R.dyn[k * 4 + 3] = -1; }
      else { R.dyn[k * 4] = Math.min(z[k] - 0.3, 0); R.dyn[k * 4 + 1] = 0; R.dyn[k * 4 + 3] = -2; }
    }
    for (let k = 0; k < N; k++) if (eta[k] === eta[k]) { R.dyn[k * 4] = eta[k]; R.dyn[k * 4 + 1] = hr[k]; }
    // 거품: 빠른 흐름(프루드 수), 수면 급상승(해일 전면), 물 끝 선단
    const decay = dtSim > 0 ? Math.exp(-dtSim / 6) : 1;
    const g = G;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i, o = k * 4;
      const wet = eta[k] === eta[k];
      if (wet) { R.dyn[o] = eta[k]; R.dyn[o + 1] = hr[k]; }
      const hk = h[k];
      let u = 0, v = 0, spd = 0;
      if (hk > 0.02) { u = hu[k] / hk; v = hv[k] / hk; spd = Math.hypot(u, v); }
      let foam = g.foam[k] * decay;
      if (mode === 'real' && hk > 0.02 && dtSim > 0) {
        const e = hk + z[k], rise = (e - g.etaPrev[k]) / dtSim;
        const fr = spd / Math.sqrt(g9 * Math.max(hk, 0.05));
        let gen = Math.max(0, Math.min(1, (fr - 0.55) * 1.4)) + Math.max(0, Math.min(1, (rise - 0.15) * 2.0));
        if (land[k] && hk < 0.6 && spd > 0.4) gen += 0.5;
        if (gen > foam) foam = Math.min(1, gen);
      }
      if (dtSim > 0) { g.foam[k] = foam; g.etaPrev[k] = hk + z[k]; }
      R.dyn[o + 2] = useMax ? G.maxS[k] : spd;
      if (wet) R.dyn[o + 3] = foam;
      // 법선(수면 기울기)
      const eL = R.dyn[(i > 0 ? k - 1 : k) * 4], eR = R.dyn[(i < nx - 1 ? k + 1 : k) * 4];
      const eB = R.dyn[(j > 0 ? k - nx : k) * 4], eT = R.dyn[(j < ny - 1 ? k + nx : k) * 4];
      R.aux[o] = Math.max(-3, Math.min(3, -(eR - eL) / ((i > 0 && i < nx - 1 ? 2 : 1) * cell)));
      R.aux[o + 1] = Math.max(-3, Math.min(3, -(eT - eB) / ((j > 0 && j < ny - 1 ? 2 : 1) * cell)));
      R.aux[o + 2] = u; R.aux[o + 3] = v;
      let val = 0;
      if (mode === 'depth') val = hk;
      else if (mode === 'max') val = G.maxH[k];
      else if (mode === 'arrival') val = G.arr[k] >= 0 ? G.arr[k] / 60 : -1;
      else if (mode === 'speed') val = useMax ? G.maxS[k] : spd;
      else if (mode === 'terrain') val = z[k];
      R.res[k * 2] = val; R.res[k * 2 + 1] = land[k];
    }
    // 마른 칸의 법선은 위 루프에서 이웃 수면 기준으로 계산됨
    S.lastRenderT = S.t; S.dirty = false;
    prim.upload = true;
  }
  // 흐름 입자
  function velAt(x, y) {
    const { nx, ny, cell, h, hu, hv } = G;
    const fi = (x + G.g.Lx / 2) / cell - 0.5, fj = (y + G.g.Wy / 2) / cell - 0.5;
    const i = Math.floor(fi), j = Math.floor(fj);
    if (i < 0 || j < 0 || i >= nx - 1 || j >= ny - 1) return null;
    const a = fi - i, b = fj - j;
    let u = 0, v = 0, hh = 0;
    const acc = (k, w) => { const hk = h[k]; if (hk > 0.03) { u += w * hu[k] / hk; v += w * hv[k] / hk; hh += w * hk; } };
    const k = j * nx + i;
    acc(k, (1 - a) * (1 - b)); acc(k + 1, a * (1 - b)); acc(k + nx, (1 - a) * b); acc(k + nx + 1, a * b);
    if (hh < 0.03) return null;
    return [u, v, R ? R.dyn[(Math.round(fj) * nx + Math.round(fi)) * 4] : 0];
  }
  function spawn(p) {
    const { nx, ny, cell, h, hu, hv } = G;
    for (let tr = 0; tr < 25; tr++) {
      const k = Math.floor(Math.random() * G.N), hk = h[k];
      if (hk < 0.1) continue;
      const s = Math.hypot(hu[k], hv[k]) / hk; if (s < 0.4) continue;
      if (!G.land[k] && Math.random() < 0.75) continue; // 바다보다 육지(침수 지역) 위주로
      const i = k % nx, j = (k - i) / nx;
      P.x[p] = -G.g.Lx / 2 + (i + Math.random()) * cell; P.y[p] = -G.g.Wy / 2 + (j + Math.random()) * cell;
      P.age[p] = 0; P.life[p] = 4 + Math.random() * 6; return true;
    }
    P.life[p] = 0; return false;
  }
  function updateParticles(dtP) {
    if (!G || !R) return;
    const arr = R.part; let o = 0;
    const show = S.particles && S.view !== 'terrain';
    for (let p = 0; p < NP; p++) {
      let ok = false, u = 0, v = 0, e = 0;
      if (show) {
        if (P.life[p] <= 0 || P.age[p] > P.life[p]) spawn(p);
        if (P.life[p] > 0) {
          const s = velAt(P.x[p], P.y[p]);
          if (s) { [u, v, e] = s; ok = Math.hypot(u, v) > 0.15; }
          if (ok) { P.x[p] += u * dtP; P.y[p] += v * dtP; P.age[p] += Math.max(dtP, 0.05); }
          else P.life[p] = 0;
        }
      }
      const sp = Math.hypot(u, v), tail = Math.min(10, 1.2 * sp + 1.5) / Math.max(sp, 1e-3);
      for (let q = 0; q < TRAIL; q++) {
        const f = q / (TRAIL - 1);
        arr[o++] = P.x[p] - u * tail * f; arr[o++] = P.y[p] - v * tail * f; arr[o++] = e + 0.25;
        const fade = Math.min(1, P.age[p] / 0.8) * Math.min(1, (P.life[p] - P.age[p]) / 1.0);
        arr[o++] = ok ? Math.max(0, fade) * (1 - 0.85 * f) * Math.min(1, 0.15 + sp / 4) * 0.8 : 0;
      }
    }
    prim.uploadPart = true;
  }

  // ---------- 셰이더 ----------
  const NOISE = `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i), hash12(i+vec2(1.0,0.0)), u.x), mix(hash12(i+vec2(0.0,1.0)), hash12(i+vec2(1.0,1.0)), u.x), u.y); }
float fbm3(vec2 p){ float a = 0.5, s = 0.0; for (int k = 0; k < 3; k++){ s += a*vnoise(p); p = mat2(1.6,1.2,-1.2,1.6)*p; a *= 0.5; } return s; }
float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int k = 0; k < 5; k++){ s += a*vnoise(p); p = mat2(1.6,1.2,-1.2,1.6)*p; a *= 0.5; } return s; }
`;
  const WATER_VS = `
in vec2 a_pos; in vec4 a_dyn; in vec4 a_aux; in vec2 a_res;
out vec3 v_posEC; out vec3 v_nEC; out vec2 v_p; out float v_h; out float v_spd; out float v_foam; out vec2 v_uv; out float v_val; out float v_land;
void main(){
  vec3 n = normalize(vec3(a_aux.x, a_aux.y, 1.0));
  vec4 lp = vec4(a_pos, a_dyn.x + 0.15 - dot(a_pos, a_pos)/12742000.0, 1.0);
  v_p = a_pos; v_h = a_dyn.y; v_spd = a_dyn.z; v_foam = max(a_dyn.w, 0.0); v_uv = a_aux.zw; v_val = a_res.x; v_land = a_res.y;
  v_posEC = (czm_modelView * lp).xyz;
  v_nEC = normalize(czm_normal * n);
  gl_Position = czm_modelViewProjection * lp;
}`;
  const WATER_FS = `
in vec3 v_posEC; in vec3 v_nEC; in vec2 v_p; in float v_h; in float v_spd; in float v_foam; in vec2 v_uv; in float v_val; in float v_land;
uniform float u_time; uniform float u_mode; uniform vec4 u_dom;
${NOISE}
vec3 depthPal(float d){
  if (d < 0.5) return vec3(0.98,0.93,0.35);
  if (d < 1.0) return vec3(0.99,0.72,0.25);
  if (d < 2.0) return vec3(0.97,0.45,0.18);
  if (d < 3.0) return vec3(0.88,0.18,0.15);
  if (d < 5.0) return vec3(0.70,0.08,0.38);
  return vec3(0.42,0.06,0.48); }
vec3 timePal(float m){
  if (m < 1.0) return vec3(0.90,0.12,0.12);
  if (m < 2.0) return vec3(0.98,0.50,0.15);
  if (m < 3.0) return vec3(0.98,0.85,0.25);
  if (m < 5.0) return vec3(0.35,0.78,0.30);
  if (m < 10.0) return vec3(0.20,0.55,0.90);
  return vec3(0.50,0.35,0.85); }
vec3 speedPal(float s){
  if (s < 0.5) return vec3(0.65,0.85,1.00);
  if (s < 1.0) return vec3(0.30,0.80,0.90);
  if (s < 2.0) return vec3(0.35,0.80,0.35);
  if (s < 4.0) return vec3(0.98,0.85,0.25);
  if (s < 6.0) return vec3(0.98,0.50,0.15);
  return vec3(0.88,0.12,0.12); }
vec3 heightPal(float z){
  float t = clamp(z/40.0, 0.0, 1.0);
  vec3 c = mix(vec3(0.15,0.55,0.25), vec3(0.95,0.85,0.30), smoothstep(0.0, 0.15, t));
  c = mix(c, vec3(0.90,0.35,0.15), smoothstep(0.15, 0.5, t));
  c = mix(c, vec3(0.55,0.10,0.45), smoothstep(0.5, 1.0, t));
  if (z < 0.0) c = mix(vec3(0.20,0.45,0.75), vec3(0.05,0.12,0.35), clamp(-z/20.0, 0.0, 1.0));
  return c; }
void main(){
  float edge = min(min(v_p.x + 0.5*u_dom.x, 0.5*u_dom.x - v_p.x), 0.5*u_dom.y - abs(v_p.y));
  float ef = smoothstep(0.0, u_dom.w, edge);
  vec3 V = normalize(-v_posEC);
  vec3 upEC = normalize(czm_normal*vec3(0.0,0.0,1.0));
  vec3 Lg = normalize(czm_lightDirectionEC);
  vec3 N = normalize(v_nEC);
  if (dot(N, V) < 0.0) N = normalize(N + V*(-dot(N,V)+0.05));
  int mode = int(u_mode + 0.5);
  if (mode != 0) {
    vec3 c; float a = 0.85;
    if (mode == 5) { c = heightPal(v_val); a = 0.8; }
    else if (mode == 1 || mode == 2) {
      if (v_land < 0.5) { c = vec3(0.22,0.42,0.62); a = 0.35; }
      else { if (v_val < 0.05) discard; c = depthPal(v_val); }
      a *= smoothstep(0.0, 0.05, v_h);
    } else if (mode == 3) {
      if (v_land < 0.5) { c = vec3(0.22,0.42,0.62); a = 0.3*smoothstep(0.0, 0.05, v_h); }
      else { if (v_val < 0.0) discard; c = timePal(v_val); }
    } else {
      c = speedPal(v_val); a *= smoothstep(0.0, 0.05, v_h); if (v_land < 0.5) a *= 0.6;
    }
    c *= 0.72 + 0.28*clamp(dot(N, Lg), 0.0, 1.0);
    a *= ef;
    if (a < 0.01) discard;
    out_FragColor = vec4(c, a);
    return;
  }
  // ----- 실감 표시 -----
  vec2 fl = clamp(v_uv, vec2(-8.0), vec2(8.0));
  float c0 = fract(u_time*0.35), c1 = fract(u_time*0.35 + 0.5);
  float bw = abs(1.0 - 2.0*c0);
  vec2 b0 = v_p*0.22 + vec2(u_time*0.06, u_time*0.03);
  vec2 qA = b0 - fl*c0*0.25, qB = b0 - fl*c1*0.25 + vec2(3.7, 1.3);
  float e = 0.12;
  float a0 = fbm3(qA), ax = fbm3(qA + vec2(e,0.0)), ay = fbm3(qA + vec2(0.0,e));
  float b0n = fbm3(qB), bx = fbm3(qB + vec2(e,0.0)), by = fbm3(qB + vec2(0.0,e));
  vec2 gr = mix(vec2(ax-a0, ay-a0), vec2(bx-b0n, by-b0n), bw)/e;
  float amp = 0.25 + min(v_spd, 6.0)*0.10;
  N = normalize(N + czm_normal*vec3(-gr*amp*0.5, 0.0));
  if (dot(N, V) < 0.0) N = normalize(N + V*(-dot(N,V)+0.05));
  vec3 R = reflect(-V, N);
  float upR = clamp(dot(R, upEC), 0.0, 1.0);
  vec3 sky = mix(vec3(0.62,0.74,0.86), vec3(0.32,0.52,0.82), pow(upR, 0.6));
  float fres = 0.02 + 0.98*pow(1.0 - clamp(dot(N,V), 0.0, 1.0), 5.0);
  // 바닷물 색: 깊을수록 짙은 청록, 얕을수록 밝은 옥빛
  float shoalF = 1.0 - smoothstep(0.4, 6.0, v_h);
  vec3 deep = vec3(0.06,0.27,0.31), shoal = vec3(0.12,0.46,0.48);
  vec3 body = mix(deep, shoal, shoalF*0.85);
  float face = clamp(1.0 - dot(N, upEC), 0.0, 1.0);
  body += vec3(0.04,0.32,0.32)*face*0.7;
  float diff = 0.45 + 0.55*clamp(dot(N, Lg), 0.0, 1.0);
  vec3 col = body*diff;
  col = mix(col, sky, fres*0.75);
  float rl = clamp(dot(R, Lg), 0.0, 1.0);
  col += vec3(1.0,0.95,0.85)*(pow(rl, 260.0)*4.0 + pow(rl, 32.0)*0.15);
  // 물 두께(장면 깊이와 비교): 건물·지면에 닿는 곳 거품, 얕은 곳 투명
  vec2 st = gl_FragCoord.xy / czm_viewport.zw;
  float sd = czm_unpackDepth(texture(czm_globeDepthTexture, st));
  float thick = 1000.0;
  if (sd > 0.0 && sd < 1.0) { vec4 eye = czm_windowToEyeCoordinates(gl_FragCoord.xy, sd); thick = length(eye.xyz) - length(v_posEC); }
  if (thick < -0.05) thick = 1000.0;
  float fnA = fbm(v_p*0.10 - fl*c0*0.10), fnB = fbm(v_p*0.10 - fl*c1*0.10 + vec2(5.1, 2.7));
  float fn = mix(fnA, fnB, bw);
  float edgeF = (1.0 - smoothstep(0.0, 0.6 + 0.8*fn, thick))*step(0.05, v_h);
  float white = smoothstep(2.5, 6.0, v_spd)*0.6;
  float foam = clamp(v_foam*smoothstep(0.30, 0.62, fn + 0.15*v_foam) + white*smoothstep(0.45, 0.7, fn) + edgeF*0.85, 0.0, 1.0);
  vec3 foamCol = vec3(0.93,0.95,0.96)*(0.62 + 0.38*clamp(dot(N, Lg), 0.0, 1.0));
  col = mix(col, foamCol, foam);
  float a = mix(0.5, 0.92, smoothstep(0.0, 2.5, min(thick, v_h*3.0 + 0.3)));
  a = max(a, foam*0.95);
  a *= smoothstep(0.0, 0.06, v_h);
  a *= ef;
  if (a < 0.01) discard;
  out_FragColor = vec4(col, a);
}`;
  const PART_VS = `
in vec4 a_p;
out float v_a;
void main(){
  vec4 ec = czm_modelView*vec4(a_p.xy, a_p.z - dot(a_p.xy, a_p.xy)/12742000.0, 1.0);
  gl_Position = czm_projection*ec;
  gl_PointSize = a_p.w > 0.0 ? clamp(0.8*czm_projection[1][1]*0.5*czm_viewport.w/max(-ec.z, 1.0), 1.5, 6.0) : 0.0;
  v_a = a_p.w;
}`;
  const PART_FS = `
in float v_a;
void main(){
  vec2 c = gl_PointCoord*2.0 - 1.0; float r2 = dot(c, c);
  if (r2 > 1.0 || v_a <= 0.01) discard;
  out_FragColor = vec4(vec3(1.0,1.0,0.96), v_a*smoothstep(1.0, 0.2, r2)*0.9);
}`;

  // ---------- 커스텀 렌더 객체 ----------
  const BLEND = { enabled: true, equationRgb: 32774, equationAlpha: 32774, functionSourceRgb: 770, functionSourceAlpha: 1, functionDestinationRgb: 771, functionDestinationAlpha: 771 };
  const uniforms = {
    u_time: () => performance.now() / 1000 % 10000,
    u_mode: () => viewCode(),
    u_dom: () => { if (G) { domVec.x = G.g.Lx; domVec.y = G.g.Wy; domVec.z = G.cell; } return domVec; },
  };
  const domVec = { x: 1, y: 1, z: 1, w: 50 };

  const prim = {
    show: true, water: null, part: null, _va: [], _sp: [], dirty: true, failed: false, upload: false, uploadPart: false,
    destroyGl() { this._va.forEach(v => { try { v.destroy(); } catch (e) {} }); this._sp.forEach(s => { try { s.destroy(); } catch (e) {} }); this._va = []; this._sp = []; this.water = this.part = null; },
    build(context) {
      this.destroyGl();
      if (!G) return;
      if (!R || R.N !== G.N) refreshRender(0);
      const { nx, ny, N, cell } = G, Lx = G.g.Lx, Wy = G.g.Wy;
      const pos = new Float32Array(N * 2);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const k = j * nx + i; pos[k * 2] = -Lx / 2 + (i + 0.5) * cell; pos[k * 2 + 1] = -Wy / 2 + (j + 0.5) * cell; }
      const idx = new Uint32Array((nx - 1) * (ny - 1) * 6); let q = 0;
      for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
        idx[q++] = a; idx[q++] = b; idx[q++] = d; idx[q++] = a; idx[q++] = d; idx[q++] = c;
      }
      const loc = { a_pos: 0, a_dyn: 1, a_aux: 2, a_res: 3 };
      const va = VertexArray.fromGeometry({
        context, attributeLocations: loc, bufferUsage: 35048,
        geometry: { attributes: {
          a_pos: { componentDatatype: 5126, componentsPerAttribute: 2, normalize: false, values: pos },
          a_dyn: { componentDatatype: 5126, componentsPerAttribute: 4, normalize: false, values: R.dyn },
          a_aux: { componentDatatype: 5126, componentsPerAttribute: 4, normalize: false, values: R.aux },
          a_res: { componentDatatype: 5126, componentsPerAttribute: 2, normalize: false, values: R.res },
        }, indices: idx, primitiveType: 4 },
      });
      // fromGeometry가 이름순으로 정렬해도 위치(location)로 찾기
      this.attrIdx = {};
      for (let i = 0; i < va.numberOfAttributes; i++) { const at = va.getAttribute(i); this.attrIdx[at.index] = at; }
      const sp = ShaderProgram.fromCache({ context, vertexShaderSource: WATER_VS, fragmentShaderSource: WATER_FS, attributeLocations: loc });
      void sp.numberOfVertexAttributes;
      const rs = RenderState.fromCache({ depthTest: { enabled: true }, depthMask: false, blending: BLEND, cull: { enabled: false } });
      const F = G.g.F;
      const bv = BoundingSphere ? new BoundingSphere(toWorld(F, 0, 0, 10), Math.hypot(Lx, Wy) / 2 + G.zMax + 60) : undefined;
      this.water = new DrawCommand({ vertexArray: va, shaderProgram: sp, renderState: rs, uniformMap: uniforms, primitiveType: 4, pass: PASS_TRANSLUCENT, modelMatrix: F.m, boundingVolume: bv, cull: !!bv, owner: this });
      this._va.push(va); this._sp.push(sp);
      // 흐름 입자
      const va2 = VertexArray.fromGeometry({ context, attributeLocations: { a_p: 0 }, bufferUsage: 35048, geometry: { attributes: { a_p: { componentDatatype: 5126, componentsPerAttribute: 4, normalize: false, values: R.part } }, primitiveType: 0 } });
      const sp2 = ShaderProgram.fromCache({ context, vertexShaderSource: PART_VS, fragmentShaderSource: PART_FS, attributeLocations: { a_p: 0 } });
      void sp2.numberOfVertexAttributes;
      this.part = new DrawCommand({ vertexArray: va2, shaderProgram: sp2, renderState: rs, uniformMap: uniforms, primitiveType: 0, pass: PASS_TRANSLUCENT, modelMatrix: F.m, boundingVolume: bv, cull: !!bv, owner: this });
      this._va.push(va2); this._sp.push(sp2);
      this.partVb = va2.getAttribute(0).vertexBuffer;
      this.dirty = false; this.upload = false; this.uploadPart = false;
    },
    update(fs) {
      if (!this.show || this.failed || !G || !fs.passes.render) return;
      try {
        if (this.dirty || !this.water) this.build(fs.context);
        if (!this.water) return;
        if (this.upload) {
          this.attrIdx[1].vertexBuffer.copyFromArrayView(R.dyn);
          this.attrIdx[2].vertexBuffer.copyFromArrayView(R.aux);
          this.attrIdx[3].vertexBuffer.copyFromArrayView(R.res);
          this.upload = false;
        }
        if (this.uploadPart) { this.partVb.copyFromArrayView(R.part); this.uploadPart = false; }
        fs.commandList.push(this.water);
        if (S.particles && S.view !== 'terrain') fs.commandList.push(this.part);
      } catch (e) {
        this.failed = true; console.error('[tsunami]', e); setStatus('렌더링 오류: ' + String(e.message || e).slice(0, 160));
      }
    },
    isDestroyed() { return false; },
    destroy() { this.destroyGl(); },
  };
  scene.primitives.add(prim);
  const rmErr = scene.renderError.addEventListener((sc, err) => {
    console.error('[tsunami] renderError', err);
    prim.failed = true;
    try { const w = viewer.cesiumWidget; if (w) w.useDefaultRenderLoop = true; } catch (e) {}
    try { const ep = document.querySelector('.cesium-widget-errorPanel'); if (ep) ep.remove(); } catch (e) {}
    setStatus('렌더링 오류가 나서 효과를 껐습니다: ' + String(err && err.message || err).slice(0, 160));
  });

  // ---------- 진행 루프 ----------
  function tick(ts) {
    S.raf = requestAnimationFrame(tick);
    const dtReal = S.lastTs ? Math.min(0.25, (ts - S.lastTs) / 1000) : 0;
    S.lastTs = ts;
    if (!G) return;
    let adv = 0;
    if (S.running && !S.computing) {
      const t1 = Math.min(G.tAvail, S.t + dtReal * S.speedMul);
      adv = t1 - S.t;
      if (adv > 0) applyTime(t1);
      if (S.t >= G.tAvail - 1e-3) { S.running = false; setStatus('재생이 끝났습니다. 결과 표시 방식을 바꿔 보세요.'); refreshButtons(); }
    }
    if (S.dirty || adv > 0) { refreshRender(adv); S.dirty = false; }
    updateParticles(S.running ? Math.min(adv, 1) : dtReal * 0.5);
    updateInfo();
  }
  S.raf = requestAnimationFrame(tick);

  // ---------- 계산 실행 ----------
  async function runCompute() {
    if (!S.A || !S.pts.length || S.computing) return;
    if (S.mode === 'pickB') finishArea();
    S.computing = true; S.running = false; refreshButtons();
    try {
      if (!capCovers(geom())) {
        setStatus('지형·건물 높이를 읽는 중입니다. 카메라가 잠시 위로 이동합니다…');
        await captureHeights();
      } else updateBaseAuto();
      if (!S.computing) throw new Error('사용자가 중지했습니다');
      buildGrid();
      const warn = G.inflowFrac < 0.15 ? `주의: 유입 경계(바다 쪽)에 바다가 ${Math.round(G.inflowFrac * 100)}%뿐입니다. 방향을 바다에서 육지 쪽으로 맞추세요. ` : '';
      const t0 = performance.now();
      const res = await new Promise((resolve, reject) => {
        let lastProg = 0;
        solver = startSolver(m => {
          if (!G) return;
          if (m.type === 'frame') { G.frames.push({ t: m.t, h: m.h, u: m.u, v: m.v }); G.tAvail = m.t; }
          else if (m.type === 'progress') {
            if (S.dead) return;
            G.h.set(m.h); G.hu.set(m.hu); G.hv.set(m.hv); G.maxH.set(m.maxH); G.arr.set(m.arr);
            const dts = m.t - S.t; S.t = m.t; refreshRender(Math.max(0, dts));
            const el = (performance.now() - t0) / 1000, eta = m.t > 5 ? el * (S.tEnd - m.t) / m.t : 0;
            if (performance.now() - lastProg > 300) {
              lastProg = performance.now();
              setProgress(m.t / S.tEnd, `${warn}흐름 계산 중… 모의 ${fmtT(m.t)} / ${fmtT(S.tEnd)} (격자 ${G.nx}×${G.ny}, ${G.cell.toFixed(1)}m)${eta > 3 ? ` · 남은 시간 약 ${fmtT(eta)}` : ''}`);
            }
            if (!S.computing && !m.stopReq) { solver.send({ cmd: 'stop' }); m.stopReq = true; }
          } else if (m.type === 'done') resolve(m);
          else if (m.type === 'error') reject(new Error(m.msg));
        });
        solver.send({ cmd: 'run', nx: G.nx, ny: G.ny, cell: G.cell, z: Float32Array.from(G.z), sea: G.sea, land: G.land, band: G.band, c0: G.c0, tEnd: S.tEnd, frameDt: G.frameDt, H: S.H, dur: S.dur });
        G.stopSolver = () => solver.send({ cmd: 'stop' });
      });
      if (!G) return;
      G.maxH.set(res.maxH); G.maxS.set(res.maxS); G.maxEta.set(res.maxEta); G.arr.set(res.arr);
      G.tAvail = res.t; S.tEnd = res.t; S.done = true;
      seek(res.t);
      summarize();
      S.view = 'max'; S.dirty = true;
      const secs = (performance.now() - t0) / 1000;
      setStatus(res.stopped ? `계산을 중지했습니다 (모의 ${fmtT(res.t)}까지). 지금까지의 결과를 표시합니다.` : `계산 완료 (${fmtT(secs)} 소요, ${res.steps.toLocaleString()}단계). 최대 침수 깊이를 표시합니다. [▶ 재생]으로 흐름을 다시 볼 수 있습니다.`);
    } catch (e) {
      console.error('[tsunami]', e); setStatus('계산 오류: ' + String(e.message || e).slice(0, 160));
    } finally {
      if (worker) { try { worker.terminate(); } catch (e) {} worker = null; }
      S.computing = false; setProgress(null); refreshButtons(); drawHelpers(); updateLegend();
    }
  }
  function summarize() {
    const { N, nx, ny, land, maxH, maxS, arr, cell, z } = G;
    let cnt = 0, mh = 0, ms = 0, first = Infinity, reach = 0, runup = -1e9;
    for (let k = 0; k < N; k++) {
      if (!land[k] || maxH[k] < 0.1) continue;
      cnt++; if (maxH[k] > mh) mh = maxH[k]; if (maxS[k] > ms) ms = maxS[k];
      if (arr[k] >= 0 && arr[k] < first) first = arr[k];
      if (z[k] > runup && maxH[k] > 0.1) runup = z[k] + maxH[k];
    }
    for (let j = 0; j < ny; j++) {
      let shore = -1, far = -1;
      for (let i = 0; i < nx; i++) { const k = j * nx + i; if (land[k] && shore < 0) shore = i; if (land[k] && maxH[k] >= 0.1) far = i; }
      if (shore >= 0 && far >= shore) reach = Math.max(reach, (far - shore + 1) * cell);
    }
    G.sum = { area: cnt * cell * cell, maxDepth: mh, maxSpeed: ms, first: isFinite(first) ? first : null, reach, runup: runup > -1e8 ? runup : null };
    renderSummary();
  }

  // ---------- 보조 표시 (구역선·방향 화살표) ----------
  function clearList(list) { list.forEach(e => viewer.entities.remove(e)); list.length = 0; }
  function purgeNamed() { viewer.entities.values.filter(e => /^__tsunami_/.test(e.name || '')).forEach(e => viewer.entities.remove(e)); }
  purgeNamed();
  function drawHelpers() {
    clearList(S.helpers);
    if (S.dead) return;
    updateAreaInfo();
    const col = c => Color.fromCssColorString(c);
    const showPts = S.guide || S.mode === 'pickA' || S.mode === 'pickB';
    if (S.A && showPts) S.helpers.push(Object.assign(viewer.entities.add({ name: '__tsunami_helper', position: S.A.c, point: { pixelSize: 12, color: col('#1e90ff'), outlineColor: Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY }, label: { text: S.mode === 'idle' && S.pts.length ? '바다 시작점 (끌어서 이동)' : '바다 시작점', font: 'bold 13px sans-serif', pixelOffset: { x: 0, y: -20 }, fillColor: Color.WHITE, showBackground: true, backgroundColor: col('rgba(20,90,180,0.85)'), disableDepthTestDistance: Number.POSITIVE_INFINITY } }), { __tsuKind: 'A' }));
    if (showPts) S.pts.forEach((p, i) => S.helpers.push(Object.assign(viewer.entities.add({ name: '__tsunami_helper', position: C3.fromDegrees(p.lon, p.lat, p.h + 2), point: { pixelSize: 11, color: col('#ff8c1a'), outlineColor: Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY }, label: { text: `도심 ${i + 1}`, font: 'bold 12px sans-serif', pixelOffset: { x: 0, y: -18 }, fillColor: Color.WHITE, showBackground: true, backgroundColor: col('rgba(190,90,10,0.85)'), disableDepthTestDistance: Number.POSITIVE_INFINITY } }), { __tsuKind: 'P', __tsuIdx: i })));
    const g = geom(); if (!g || !S.guide) return;
    const F = g.F, L2 = g.Lx / 2, W2 = g.Wy / 2, zz = 3;
    const edge = (x0, y0, x1, y1) => { const n = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 200)); const out = []; for (let i = 0; i <= n; i++) { const x = x0 + (x1 - x0) * i / n, y = y0 + (y1 - y0) * i / n; out.push(toWorld(F, x, y, zz - (x * x + y * y) / (2 * RE))); } return out; };
    const ring = [...edge(-L2, -W2, L2, -W2), ...edge(L2, -W2, L2, W2).slice(1), ...edge(L2, W2, -L2, W2).slice(1), ...edge(-L2, W2, -L2, -W2).slice(1)];
    S.helpers.push(viewer.entities.add({ name: '__tsunami_helper', polyline: { positions: ring, width: 2, material: col('rgba(255,210,0,0.9)'), depthFailMaterial: col('rgba(255,210,0,0.35)') } }));
    S.helpers.push(viewer.entities.add({ name: '__tsunami_helper', polyline: { positions: edge(-L2, -W2, -L2, W2), width: 5, material: col('rgba(40,150,255,0.95)'), depthFailMaterial: col('rgba(40,150,255,0.4)') } }));
    // 진행 방향 화살표 (유입 경계에서 안쪽으로)
    const ax0 = -L2 - Math.min(120, 0.12 * g.Lx), ax1 = -L2 + Math.min(260, 0.3 * g.Lx), hw = Math.min(70, 0.08 * g.Wy), za = 12;
    S.helpers.push(viewer.entities.add({ name: '__tsunami_helper', polyline: { positions: [toWorld(F, ax0, 0, za), toWorld(F, ax1, 0, za)], width: 7, material: col('rgba(255,90,40,0.95)'), depthFailMaterial: col('rgba(255,90,40,0.45)') } }));
    S.helpers.push(viewer.entities.add({ name: '__tsunami_helper', polyline: { positions: [toWorld(F, ax1 - hw * 1.3, -hw, za), toWorld(F, ax1, 0, za), toWorld(F, ax1 - hw * 1.3, hw, za)], width: 7, material: col('rgba(255,90,40,0.95)'), depthFailMaterial: col('rgba(255,90,40,0.45)') } }));
    S.helpers.push(viewer.entities.add({ name: '__tsunami_helper', position: toWorld(F, ax0, 0, za), label: { text: `쓰나미 진행 방향: ${compass(S.bearing)} (${Math.round(S.bearing)}°)`, font: 'bold 13px sans-serif', pixelOffset: { x: 0, y: -18 }, fillColor: Color.WHITE, showBackground: true, backgroundColor: col('rgba(200,60,20,0.85)'), disableDepthTestDistance: Number.POSITIVE_INFINITY } }));
    // 가장 안쪽 경계(도심 쪽 끝)
    S.helpers.push(viewer.entities.add({ name: '__tsunami_helper', position: toWorld(F, L2, 0, 15), label: { text: `구역 안쪽 끝 (해안 시작점에서 ${(g.Lx - S.seaPad) >= 1000 ? ((g.Lx - S.seaPad) / 1000).toFixed(1) + ' km' : Math.round(g.Lx - S.seaPad) + ' m'})`, font: '12px sans-serif', pixelOffset: { x: 0, y: -14 }, fillColor: Color.WHITE, showBackground: true, backgroundColor: col('rgba(120,100,0,0.8)'), disableDepthTestDistance: Number.POSITIVE_INFINITY } }));
  }
  function updateAreaInfo() {
    const el = panel && panel.querySelector('.ar'); if (!el) return;
    const g = geom(); if (!g) { el.textContent = ''; return; }
    const c = Math.max(cellSizeFor(g), CAP && capCovers(g) ? CAP.cell : 0), n = Math.round(g.Lx / c) * Math.round(g.Wy / c);
    const km = v => v >= 1000 ? (v / 1000).toFixed(2) + ' km' : Math.round(v) + ' m';
    el.innerHTML = `구역 크기 <b>${km(g.Lx)} × ${km(g.Wy)}</b> · 계산 칸 <b>${c.toFixed(1)} m</b> (약 ${n >= 10000 ? (n / 10000).toFixed(1) + '만' : Math.round(n / 1000) + '천'} 칸)`;
  }
  // ---------- 지점 측정 ----------
  function cellAt(c) {
    if (!G) return -1;
    const [x, y] = toLocal(G.g.F, c);
    const i = Math.floor((x + G.g.Lx / 2) / G.cell), j = Math.floor((y + G.g.Wy / 2) / G.cell);
    if (i < 0 || j < 0 || i >= G.nx || j >= G.ny) return -1;
    return j * G.nx + i;
  }
  function probe(p) {
    const k = cellAt(p.c); let text;
    if (k < 0) text = '계산 구역 밖입니다';
    else {
      const z = G.z[k], h = G.h[k], mh = G.maxH[k], ms = G.maxS[k], ar = G.arr[k];
      const sp = h > 0.05 ? Math.hypot(G.hu[k], G.hv[k]) / h : 0;
      text = (G.land[k] ? `지면·건물 높이 ${z.toFixed(1)}m (해수면 기준)` : `바다 (가정 수심 ${(-z).toFixed(1)}m)`) +
        `\n현재(${fmtT(S.t)}) 침수 ${h > 0.05 ? h.toFixed(2) + 'm' : '없음'}${h > 0.05 ? `, 유속 ${sp.toFixed(1)}m/s` : ''}` +
        `\n최대 침수 깊이 ${mh > 0.05 ? mh.toFixed(2) + 'm' : '없음'}` +
        (ms > 0.05 ? `\n최대 유속 ${ms.toFixed(1)}m/s` : '') +
        (G.land[k] ? `\n도달 시간 ${ar >= 0 ? fmtT(ar) : '도달 안 함'}` : '');
    }
    S.probes.push(viewer.entities.add({
      name: '__tsunami_probe', position: p.c,
      point: { pixelSize: 9, color: Color.fromCssColorString('#ff3b30'), outlineColor: Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      label: { text, font: '13px sans-serif', pixelOffset: { x: 0, y: -52 }, fillColor: Color.WHITE, showBackground: true, backgroundColor: Color.fromCssColorString('rgba(20,30,45,0.88)'), disableDepthTestDistance: Number.POSITIVE_INFINITY },
    }));
  }

  // ---------- 시점 ----------
  function look(F, px, py, pz, tx, ty, tz, dur = 2) {
    const pos = toWorld(F, px, py, pz), tgt = toWorld(F, tx, ty, tz);
    const d = C3.normalize(C3.subtract(tgt, pos, new C3()), new C3());
    const upL = dirWorld(F, 0, 0, 1);
    const right = C3.normalize(C3.cross(d, upL, new C3()), new C3());
    const up = C3.normalize(C3.cross(right, d, new C3()), new C3());
    camera.flyTo({ destination: pos, orientation: { direction: d, up }, duration: dur });
  }
  function viewAir() { const g = geom(); if (!g) return; look(g.F, -g.Lx * 0.95, -g.Wy * 0.55, Math.max(300, g.Lx * 0.55), g.Lx * 0.05, 0, 0); }
  function viewTop() {
    const g = geom(); if (!g) return; const F = g.F;
    const alt = Math.max(g.Lx, g.Wy) * 1.25;
    camera.flyTo({ destination: toWorld(F, 0, 0, alt), orientation: { direction: dirWorld(F, 0, 0, -1), up: dirWorld(F, 1, 0, 0) }, duration: 2 });
  }
  function viewGround() {
    const g = geom(); if (!g) return;
    let x = 0, zg = 2;
    if (G) {
      const j = Math.floor(G.ny / 2);
      for (let i = 0; i < G.nx; i++) { const k = j * G.nx + i; if (G.land[k]) { x = -g.Lx / 2 + (i + 0.5) * G.cell; zg = G.z[k]; break; } }
    }
    if (S.guide) { S.guide = false; drawHelpers(); refreshButtons(); }
    look(g.F, x + 45, g.Wy * 0.04, zg + Math.max(8, S.H * 1.2), x - 300, 0, zg + S.H * 0.5);
  }

  // ---------- 마우스 ----------
  let down = null, drag = null;
  const ssc = scene.screenSpaceCameraController;
  const ghost = document.createElement('div');
  ghost.style.cssText = 'position:fixed;z-index:70;pointer-events:none;display:none;transform:translate(-50%,-50%);width:14px;height:14px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 2px rgba(0,0,0,.35)';
  const ghostLb = document.createElement('div');
  ghostLb.style.cssText = 'position:absolute;left:50%;bottom:18px;transform:translateX(-50%);white-space:nowrap;font:bold 12px sans-serif;color:#fff;padding:2px 6px;border-radius:4px';
  ghost.appendChild(ghostLb); document.body.appendChild(ghost);
  function distFromA(p) { return Math.hypot((p.lon - S.A.lon) * mPerDegLon(S.A.lat), (p.lat - S.A.lat) * mPerDegLat(S.A.lat)); }
  // 시작점 변경: 도심 지점은 그대로 두고 시작점만 바꾼다
  function moveStart(p) {
    const old = S.A; S.A = p;
    const bad = S.pts.find(q => distFromA(q) < 100 || distFromA(q) > 7500);
    if (bad) { S.A = old; setStatus('도심 지점과 너무 가깝거나(100m 미만) 너무 멉니다(7.5km 초과). 다른 곳을 고르세요.'); drawHelpers(); return false; }
    if (!S.bearingManual) autoBearing();
    invalidate(false); drawHelpers();
    setStatus('시작점을 옮겼습니다. 도심 지점과 설정은 그대로입니다. [계산 실행]을 누르세요.');
    return true;
  }
  function movePoint(i, p) {
    if (distFromA(p) < 100 || distFromA(p) > 7500) { setStatus('시작점에서 100m~7.5km 사이만 지정할 수 있습니다.'); drawHelpers(); return; }
    S.pts[i] = p; if (!S.bearingManual) autoBearing(); invalidate(false); drawHelpers();
    setStatus(`도심 ${i + 1} 지점을 옮겼습니다. [계산 실행]을 누르세요.`);
  }
  const onDown = e => {
    down = { x: e.clientX, y: e.clientY };
    if (S.computing || S.mode === 'pickA' || S.mode === 'pickB' || e.button !== 0) return;
    const r = canvas.getBoundingClientRect();
    let ent = null;
    try {
      const pos = { x: e.clientX - r.left, y: e.clientY - r.top };
      for (const o of scene.drillPick(pos, 6, 9, 9)) if (o && o.id && o.id.__tsuKind) { ent = o.id; break; }
    } catch (err) {}
    if (!ent || !ent.__tsuKind) return;
    drag = { kind: ent.__tsuKind, idx: ent.__tsuIdx, ent, inputs: ssc.enableInputs, moved: false };
    ssc.enableInputs = false;
    ent.show = false;
    ghost.style.background = drag.kind === 'A' ? '#1e90ff' : '#ff8c1a';
    ghostLb.style.background = drag.kind === 'A' ? 'rgba(20,90,180,.9)' : 'rgba(190,90,10,.9)';
    ghostLb.textContent = drag.kind === 'A' ? '바다 시작점' : `도심 ${drag.idx + 1}`;
    ghost.style.left = e.clientX + 'px'; ghost.style.top = e.clientY + 'px'; ghost.style.display = 'block';
    setStatus('놓을 곳으로 끌어다 놓으세요.');
  };
  const onMove = e => {
    if (!drag) return;
    drag.moved = drag.moved || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 3;
    ghost.style.left = e.clientX + 'px'; ghost.style.top = e.clientY + 'px';
  };
  function endDrag(e) {
    const d = drag; drag = null;
    ghost.style.display = 'none';
    ssc.enableInputs = d.inputs;
    d.ent.show = true;
    if (!d.moved) { drawHelpers(); setStatus(d.kind === 'A' ? '시작점은 마우스로 끌어서 옮길 수 있습니다.' : '도심 지점은 마우스로 끌어서 옮길 수 있습니다.'); return; }
    const r = canvas.getBoundingClientRect();
    const p = pickAt(e.clientX - r.left, e.clientY - r.top);
    if (!p) { drawHelpers(); setStatus('그 위치의 높이를 읽지 못했습니다. 모델 위에 놓으세요.'); return; }
    if (d.kind === 'A') moveStart(p); else movePoint(d.idx, p);
    refreshButtons();
  }
  const onWinUp = e => { if (drag) endDrag(e); };
  const onUp = e => {
    if (drag) { endDrag(e); return; }
    if (!down || S.mode === 'idle') return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    if (S.mode === 'pickB') {
      const now = performance.now(), lu = S.lastUp;
      if (lu && now - lu.t < 400 && Math.hypot(e.clientX - lu.x, e.clientY - lu.y) < 8 && S.pts.length) { S.lastUp = null; finishArea(); refreshButtons(); return; }
      S.lastUp = { t: now, x: e.clientX, y: e.clientY };
    }
    const r = canvas.getBoundingClientRect();
    const p = pickAt(e.clientX - r.left, e.clientY - r.top);
    if (!p) { setStatus('그 위치의 높이를 읽지 못했습니다. 모델 위를 다시 클릭하세요.'); return; }
    if (S.mode === 'pickA') {
      S.A = p; S.pts = []; S.mode = 'pickB'; S.bearingManual = false; invalidate(false); drawHelpers();
      setStatus('② 물이 어디까지 들어가는지 보고 싶은 도심 지점을 클릭하세요. 여러 곳을 찍을 수 있고, 끝나면 [지정 완료] 또는 더블클릭.');
    } else if (S.mode === 'moveA') {
      if (moveStart(p)) S.mode = 'idle';
    } else if (S.mode === 'pickB') {
      const dA = distFromA(p);
      if (dA < 100) { setStatus('바다 시작점과 너무 가깝습니다 (100m 이상 떨어진 곳).'); return; }
      if (dA > 7500) { setStatus('바다 시작점에서 7.5km 이내만 지정할 수 있습니다.'); return; }
      if (S.pts.length >= 12) { setStatus('도심 지점은 12개까지입니다. [지정 완료]를 누르세요.'); return; }
      S.pts.push(p); if (!S.bearingManual) autoBearing(); invalidate(false); drawHelpers();
      setStatus(`도심 지점 ${S.pts.length}개 지정됨. 더 클릭하거나 [지정 완료](또는 더블클릭)를 누르세요.`);
    } else if (S.mode === 'probe') probe(p);
    refreshButtons();
  };
  canvas.addEventListener('pointerdown', onDown, true);
  canvas.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onWinUp, true);
  // 시작점을 진행 방향 앞뒤로 조금씩 옮기기 (거리 m, +면 육지 쪽)
  function nudgeStart(dist) {
    if (!S.A) return;
    const kx = Math.sin(S.bearing * DEG), ky = Math.cos(S.bearing * DEG);
    const lon = S.A.lon + dist * kx / mPerDegLon(S.A.lat), lat = S.A.lat + dist * ky / mPerDegLat(S.A.lat);
    const keep = S.bearingManual; S.bearingManual = true;   // 앞뒤 이동은 방향을 바꾸지 않음
    const ok = moveStart({ lon, lat, h: S.A.h, c: C3.fromDegrees(lon, lat, S.A.h) });
    S.bearingManual = keep;
    if (ok) setStatus(`시작점을 ${dist > 0 ? '육지' : '바다'} 쪽으로 ${Math.abs(dist)}m 옮겼습니다. [계산 실행]을 누르세요.`);
  }

  function autoBearing() {
    if (!S.A || !S.pts.length) return;
    let E = 0, N = 0;
    for (const p of S.pts) { E += (p.lon - S.A.lon) * mPerDegLon(S.A.lat); N += (p.lat - S.A.lat) * mPerDegLat(S.A.lat); }
    setBearing(Math.atan2(E, N) / DEG, false);
  }
  function finishArea() {
    if (!S.A || !S.pts.length) return;
    S.mode = 'idle'; drawHelpers();
    setStatus('구역 지정 완료. 노란 선이 계산 구역입니다. 파란 시작점·주황 도심 지점은 끌어서 옮길 수 있습니다. 방향을 확인한 뒤 [계산 실행]을 누르세요.');
  }
  // 설정이 바뀌면 이전 결과 무효화 (높이 자료는 새 구역을 덮으면 다시 씀)
  function invalidate(recapture) {
    S.computing = false; S.running = false; S.done = false;
    if (worker) { try { worker.terminate(); } catch (e) {} worker = null; }
    if (recapture) { CAP = null; S.baseAuto = 0; }
    G = null; R = null; prim.destroyGl(); prim.dirty = true;
    S.t = 0; S.view = S.view === 'terrain' ? 'terrain' : 'real';
    renderSummary(); updateLegend();
  }
  function setBearing(b, inv = true) {
    S.bearing = ((b % 360) + 360) % 360;
    const inp = $('input[data-k=bearing]'); inp.value = Math.round(S.bearing);
    $('[data-v=bearing]').textContent = `${Math.round(S.bearing)}°`;
    $('.cmp').textContent = `${compass(S.bearing)} 쪽으로 진행 (${compass(S.bearing + 180)}에서 밀려옴)`;
    if (inv) invalidate(false);
    drawHelpers();
  }

  // ---------- 패널 ----------
  const panel = document.createElement('div');
  panel.id = 'tsunami-panel';
  panel.innerHTML = `
  <style>
    #tsunami-panel{position:fixed;left:16px;bottom:16px;width:318px;max-height:calc(100vh - 96px);overflow:auto;z-index:60;background:rgba(15,22,35,.93);color:#e8eef7;border:1px solid rgba(120,170,230,.35);border-radius:12px;font:12.5px/1.4 system-ui,'Malgun Gothic',sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.35);backdrop-filter:blur(6px)}
    #tsunami-panel .hd{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid rgba(255,255,255,.08);cursor:pointer;position:sticky;top:0;background:rgba(15,22,35,.97);z-index:1}
    #tsunami-panel .hd b{font-size:13.5px;border-left:3px solid #3aa0ff;padding-left:8px}
    #tsunami-panel .bd{padding:8px 12px 10px;display:grid;gap:6px}
    #tsunami-panel.min .bd{display:none}
    #tsunami-panel .row{display:grid;grid-template-columns:70px 1fr 46px;align-items:center;gap:6px}
    #tsunami-panel input[type=range]{width:100%}
    #tsunami-panel input[type=number]{width:100%;background:#0b1220;color:#e8eef7;border:1px solid #34445e;border-radius:6px;padding:2px 4px}
    #tsunami-panel .val{text-align:right;color:#9cc8ff}
    #tsunami-panel .btns{display:flex;flex-wrap:wrap;gap:4px}
    #tsunami-panel button{flex:1 1 auto;background:#1d2b44;color:#e8eef7;border:1px solid #3a5070;border-radius:8px;padding:4px 6px;cursor:pointer;font-size:12px}
    #tsunami-panel button:hover{background:#27406a}
    #tsunami-panel button.on{background:#2f6fd6;border-color:#5b9bff}
    #tsunami-panel button.go{background:#1f7a4d;border-color:#2fae6f}
    #tsunami-panel button:disabled{opacity:.45;cursor:default}
    #tsunami-panel .st{background:rgba(58,160,255,.12);border-radius:8px;padding:6px 8px;color:#cfe5ff;min-height:20px}
    #tsunami-panel .sec{font-size:11.5px;color:#8fb3e0;margin-top:2px;border-top:1px solid rgba(255,255,255,.07);padding-top:5px}
    #tsunami-panel .ar{font-size:11.5px;color:#cfe0f5;background:rgba(255,210,0,.08);border-left:3px solid #ffd200;border-radius:4px;padding:3px 6px}
    #tsunami-panel .ar:empty{display:none}
    #tsunami-panel .ar b{color:#ffe27a}
    #tsunami-panel .cmp{font-size:11.5px;color:#ffb38f;text-align:right}
    #tsunami-panel .pg{height:6px;background:#0b1220;border-radius:4px;overflow:hidden;display:none}
    #tsunami-panel .pg i{display:block;height:100%;width:0;background:linear-gradient(90deg,#2f8cff,#43d9a3)}
    #tsunami-panel .info{display:grid;grid-template-columns:1fr 1fr;gap:2px 8px;color:#b8c7dc;font-size:11.5px}
    #tsunami-panel .info b{color:#fff}
    #tsunami-panel .lg{display:flex;flex-wrap:wrap;gap:3px 8px;font-size:11px;color:#cdd8e8}
    #tsunami-panel .lg span{display:inline-flex;align-items:center;gap:3px}
    #tsunami-panel .lg i{display:inline-block;width:12px;height:10px;border-radius:2px}
    #tsunami-panel .sum{display:grid;grid-template-columns:1fr 1fr;gap:2px 8px;font-size:11.5px;color:#b8c7dc}
    #tsunami-panel .sum b{color:#ffd28f}
  </style>
  <div class="hd"><b>쓰나미 침수 시뮬레이션 (도심 침투)</b><span class="tg">접기 ▾</span></div>
  <div class="bd">
    <div class="btns"><button data-a="area">구역 지정</button><button data-a="done" style="flex:0 0 auto">지정 완료</button><button data-a="undo" style="flex:0 0 auto">한 점 취소</button><button data-a="clear" style="flex:0 0 auto">지우기</button></div>
    <div class="btns"><button data-a="moveA">시작점 옮기기</button><button data-a="nudgeSea" style="flex:0 0 auto" title="시작점을 진행 방향 반대(바다) 쪽으로 100m">◀ 바다 쪽</button><button data-a="nudgeLand" style="flex:0 0 auto" title="시작점을 진행 방향(육지) 쪽으로 100m">육지 쪽 ▶</button></div>
    <div class="st">[구역 지정]을 누른 뒤 ① 바다 위 지점, ② 물이 들어가는지 보고 싶은 도심 지점(여러 곳 가능)을 차례로 클릭하세요.</div>
    <div class="ar"></div>
    <div class="row" title="가장 안쪽 도심 지점보다 더 안쪽으로 구역을 넓힙니다"><span>내륙 연장</span><input type="range" min="0" max="3000" step="50" value="300" data-k="extra"><span class="val" data-v="extra">+300 m</span></div>
    <div class="btns"><button data-a="deeper">도심 쪽으로 +500 m</button><button data-a="shallower" style="flex:0 0 auto">-500 m</button></div>
    <div class="row" title="지정한 지점들보다 좁아지지는 않습니다"><span>최소 폭</span><input type="range" min="300" max="5000" step="100" value="800" data-k="W"><span class="val" data-v="W">800 m</span></div>
    <div class="row" title="바다 시작점보다 바다 쪽으로 더 둘 여유 거리"><span>바다 여유</span><input type="range" min="100" max="1000" step="50" value="200" data-k="seaPad"><span class="val" data-v="seaPad">200 m</span></div>
    <div class="row"><span>진행 방향</span><input type="range" min="0" max="359" step="1" value="0" data-k="bearing"><span class="val" data-v="bearing">0°</span></div>
    <div class="cmp">-</div>
    <div class="btns"><button data-a="rotL">↺ 15°</button><button data-a="rotR">↻ 15°</button><button data-a="flip">반대 방향</button></div>
    <div class="row"><span>입사 파고</span><input type="range" min="1" max="20" step="0.5" value="6" data-k="H"><span class="val" data-v="H">6 m</span></div>
    <div class="row"><span>지속 시간</span><input type="range" min="30" max="1200" step="10" value="180" data-k="dur"><span class="val" data-v="dur">180초</span></div>
    <div class="row"><span>앞바다 수심</span><input type="range" min="3" max="60" step="1" value="15" data-k="D"><span class="val" data-v="D">15 m</span></div>
    <div class="row"><span>해수면 보정</span><input type="number" step="0.25" value="0" data-k="baseAdj"><span class="val">m</span></div>
    <div class="btns"><span style="align-self:center;color:#b8c7dc;margin-right:2px">정밀도</span><button data-prec="fast">빠름</button><button data-prec="normal" class="on">보통</button><button data-prec="fine">정밀</button></div>
    <div class="btns"><button data-a="run" class="go">계산 실행</button><button data-a="stop" style="flex:0 0 auto">중지</button><button data-a="recap" style="flex:0 0 auto">지형 다시 읽기</button></div>
    <div class="pg"><i></i></div>
    <div class="sec">재생</div>
    <div class="btns"><button data-a="play" class="go">▶ 재생</button><button data-a="pause">일시정지</button><button data-a="reset">처음으로</button></div>
    <div class="row"><span>시간</span><input type="range" min="0" max="1000" step="1" value="0" data-k="time"><span class="val" data-v="time">0초</span></div>
    <div class="row"><span>재생 배속</span><input type="range" min="1" max="30" step="1" value="5" data-k="speedMul"><span class="val" data-v="speedMul">5배</span></div>
    <div class="sec">결과 표시</div>
    <div class="btns" data-g="view"><button data-view="real" class="on">실감</button><button data-view="depth">침수 깊이</button><button data-view="max">최대 침수</button><button data-view="arrival">도달 시간</button><button data-view="speed">유속</button><button data-view="terrain">분석 지형</button></div>
    <div class="lg"></div>
    <div class="btns"><button data-a="particles" class="on">흐름 입자</button><button data-a="guide" class="on">구역·방향 표시</button><button data-a="probe">지점 측정</button></div>
    <div class="btns"><button data-a="vground">지상 시점</button><button data-a="vair">항공 시점</button><button data-a="vtop">위에서 보기</button></div>
    <div class="info">
      <span>모의 시간 <b data-i="t">0초</b></span><span>침수 면적 <b data-i="area">-</b></span>
      <span>격자 <b data-i="grid">-</b></span><span>해수면 <b data-i="base">-</b></span>
    </div>
    <div class="sum"></div>
  </div>`;
  document.body.appendChild(panel);
  const $ = sel => panel.querySelector(sel);
  function setStatus(m) { $('.st').textContent = m; }
  function setProgress(f, msg) {
    const pg = $('.pg'); if (f == null) { pg.style.display = 'none'; return; }
    pg.style.display = 'block'; pg.firstElementChild.style.width = `${Math.round(f * 100)}%`; if (msg) setStatus(msg);
  }
  const fmtT = s => { s = Math.round(s); return s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초`; };
  let lastInfo = 0;
  function updateInfo() {
    const now = performance.now(); if (now - lastInfo < 200) return; lastInfo = now;
    $('[data-i=t]').textContent = fmtT(S.t);
    const ts = $('input[data-k=time]');
    if (document.activeElement !== ts) ts.value = S.tEnd ? Math.round(1000 * S.t / S.tEnd) : 0;
    $('[data-v=time]').textContent = fmtT(S.t);
    if (G) {
      let c = 0; for (let k = 0; k < G.N; k++) if (G.land[k] && G.h[k] > 0.1) c++;
      const a = c * G.cell * G.cell;
      $('[data-i=area]').textContent = a > 1e6 ? `${(a / 1e6).toFixed(2)} km²` : `${Math.round(a).toLocaleString()} m²`;
      $('[data-i=grid]').textContent = `${G.nx}×${G.ny} (${G.cell.toFixed(1)}m)`;
    } else { $('[data-i=area]').textContent = '-'; $('[data-i=grid]').textContent = '-'; }
    $('[data-i=base]').textContent = S.A ? `${(S.baseAuto + S.baseAdj >= 0 ? '+' : '')}${(S.baseAuto + S.baseAdj).toFixed(2)} m` : '-';
  }
  function renderSummary() {
    const el = $('.sum');
    if (!G || !G.sum || !S.done) { el.innerHTML = ''; return; }
    const s = G.sum;
    el.innerHTML = `<span>최종 침수 면적 <b>${s.area > 1e6 ? (s.area / 1e6).toFixed(2) + ' km²' : Math.round(s.area).toLocaleString() + ' m²'}</b></span>
      <span>육지 최대 깊이 <b>${s.maxDepth.toFixed(1)} m</b></span>
      <span>육지 최대 유속 <b>${s.maxSpeed.toFixed(1)} m/s</b></span>
      <span>최초 상륙 <b>${s.first != null ? fmtT(s.first) : '-'}</b></span>
      <span>내륙 도달 거리 <b>${Math.round(s.reach)} m</b></span>
      <span>최고 도달 높이 <b>${s.runup != null ? s.runup.toFixed(1) + ' m' : '-'}</b></span>`;
  }
  const LEG = {
    real: '',
    depth: [['#fae959', '~0.5m'], ['#fcb840', '0.5~1m'], ['#f7732e', '1~2m'], ['#e02e26', '2~3m'], ['#b3145f', '3~5m'], ['#6b0f7a', '5m 이상']],
    arrival: [['#e61f1f', '~1분'], ['#fa8026', '1~2분'], ['#fad940', '2~3분'], ['#59c74d', '3~5분'], ['#338ce6', '5~10분'], ['#8059d9', '10분~']],
    speed: [['#a6d9ff', '~0.5m/s'], ['#4dcce6', '0.5~1'], ['#59cc59', '1~2'], ['#fad940', '2~4'], ['#fa8026', '4~6'], ['#e01f1f', '6m/s 이상']],
    terrain: [['#2e7d4a', '0m'], ['#f2d94d', '6m'], ['#e65a26', '20m'], ['#8c1a73', '40m 이상'], ['#2e6bbf', '바다(가정 수심)']],
  };
  LEG.max = LEG.depth;
  function updateLegend() {
    const l = LEG[S.view];
    const head = { real: '물 색: 바닷물 색 (깊으면 짙은 청록, 얕으면 밝은 옥빛). 흰 거품 = 빠른 흐름·해일 전면', depth: '현재 침수 깊이', max: '전체 시간 중 최대 침수 깊이', arrival: '물이 처음 도달한 시간 (육지)', speed: '현재 유속 (흰 입자 = 흐름 방향)', terrain: '계산에 쓰인 지형·건물 높이 (해수면 기준)' }[S.view];
    $('.lg').innerHTML = `<div style="width:100%;color:#8fa3bd">${head}</div>` + (l ? l.map(([c, t]) => `<span><i style="background:${c}"></i>${t}</span>`).join('') : '');
    panel.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === S.view));
  }
  function refreshButtons() {
    const has = !!(S.A && S.pts.length), busy = S.computing;
    ['run', 'recap', 'vground', 'vair', 'vtop', 'rotL', 'rotR', 'flip', 'deeper', 'shallower', 'moveA', 'nudgeSea', 'nudgeLand'].forEach(a => { $(`[data-a=${a}]`).disabled = !has || busy; });
    ['play', 'pause', 'reset', 'probe'].forEach(a => { $(`[data-a=${a}]`).disabled = !G || busy; });
    $('[data-a=stop]').disabled = !busy;
    $('[data-a=done]').disabled = !(S.mode === 'pickB' && S.pts.length);
    $('[data-a=undo]').disabled = !S.pts.length || busy;
    $('[data-a=area]').disabled = busy;
    $('[data-a=area]').classList.toggle('on', S.mode === 'pickA' || S.mode === 'pickB');
    $('[data-a=probe]').classList.toggle('on', S.mode === 'probe');
    $('[data-a=moveA]').classList.toggle('on', S.mode === 'moveA');
    $('[data-a=pause]').classList.toggle('on', !!G && !S.running && S.t > 0);
    $('[data-a=particles]').classList.toggle('on', S.particles);
    $('[data-a=guide]').classList.toggle('on', S.guide);
    panel.querySelectorAll('[data-prec]').forEach(b => { b.classList.toggle('on', b.dataset.prec === S.prec); b.disabled = busy; });
    panel.querySelectorAll('input[data-k]').forEach(i => { if (i.dataset.k !== 'time' && i.dataset.k !== 'speedMul') i.disabled = busy; });
  }
  $('.hd').onclick = () => { panel.classList.toggle('min'); $('.tg').textContent = panel.classList.contains('min') ? '펼치기 ▴' : '접기 ▾'; };
  const UNIT = { H: v => v + ' m', D: v => v + ' m', W: v => v + ' m', seaPad: v => v + ' m', extra: v => '+' + v + ' m', dur: v => v + '초', speedMul: v => v + '배' };
  function setSlider(k, v) { S[k] = v; const i = $(`input[data-k=${k}]`); if (i) i.value = v; const o = $(`[data-v=${k}]`); if (o) o.textContent = UNIT[k](v); }
  panel.querySelectorAll('input[type=range]').forEach(inp => {
    const k = inp.dataset.k;
    if (k === 'time') { inp.onchange = () => { if (G && !S.computing && G.frames.length) { S.running = false; seek(+inp.value / 1000 * S.tEnd); refreshButtons(); } }; return; }
    inp.oninput = () => {
      const v = +inp.value;
      if (k === 'bearing') { S.bearingManual = true; setBearing(v); refreshButtons(); return; }
      setSlider(k, v);
      if (k === 'W' || k === 'extra' || k === 'seaPad') { invalidate(false); drawHelpers(); }
      if (k === 'H' || k === 'dur' || k === 'D') invalidate(false);
      refreshButtons();
    };
  });
  $('input[data-k=baseAdj]').oninput = e => { S.baseAdj = +e.target.value || 0; invalidate(false); drawHelpers(); };
  panel.addEventListener('click', e => {
    const vb = e.target.closest('[data-view]');
    if (vb) {
      S.view = vb.dataset.view;
      if (!S.done && ['max', 'arrival'].includes(S.view)) setStatus('최대 침수·도달 시간은 지금까지 계산된 시간까지만 반영됩니다.');
      S.dirty = true; updateLegend(); return;
    }
    const pb = e.target.closest('[data-prec]');
    if (pb && !pb.disabled) { S.prec = pb.dataset.prec; invalidate(false); drawHelpers(); refreshButtons(); return; }
    const a = e.target.closest('button')?.dataset.a; if (!a) return;
    if (a === 'area') {
      S.mode = 'pickA'; S.A = null; S.pts = []; S.bearingManual = false; invalidate(false); drawHelpers();
      setStatus('① 바다 위(해일이 들어오는 쪽)를 클릭하세요.');
    }
    if (a === 'done') finishArea();
    if (a === 'undo') { S.pts.pop(); if (S.pts.length) autoBearing(); invalidate(false); drawHelpers(); setStatus(`도심 지점 ${S.pts.length}개`); }
    if (a === 'deeper') { setSlider('extra', Math.min(3000, S.extra + 500)); invalidate(false); drawHelpers(); }
    if (a === 'shallower') { setSlider('extra', Math.max(0, S.extra - 500)); invalidate(false); drawHelpers(); }
    if (a === 'rotL') { S.bearingManual = true; setBearing(S.bearing - 15); }
    if (a === 'rotR') { S.bearingManual = true; setBearing(S.bearing + 15); }
    if (a === 'flip') { S.bearingManual = true; setBearing(S.bearing + 180); }
    if (a === 'moveA') { S.mode = S.mode === 'moveA' ? 'idle' : 'moveA'; setStatus(S.mode === 'moveA' ? '새 바다 시작점을 클릭하세요. 도심 지점과 설정은 그대로 유지됩니다. (파란 점을 직접 끌어서 옮겨도 됩니다)' : '시작점 옮기기를 취소했습니다.'); }
    if (a === 'nudgeSea') nudgeStart(-100);
    if (a === 'nudgeLand') nudgeStart(100);
    if (a === 'run') runCompute();
    if (a === 'stop') { S.computing = false; if (G && G.stopSolver) G.stopSolver(); }
    if (a === 'recap') { invalidate(true); runCompute(); }
    if (a === 'play' && G) {
      if (S.t >= G.tAvail - 0.5) seek(0);
      if (S.view === 'max' || S.view === 'arrival' || S.view === 'terrain') { S.view = 'real'; updateLegend(); }
      S.running = true; setStatus('해일이 밀려오고 있습니다. 건물과 지형을 따라 물길이 바뀌는 모습을 보세요.');
    }
    if (a === 'pause') { S.running = false; setStatus('일시정지'); }
    if (a === 'reset' && G) { S.running = false; seek(0); setStatus('처음 상태입니다. [▶ 재생]을 누르세요.'); }
    if (a === 'probe') { S.mode = S.mode === 'probe' ? 'idle' : 'probe'; setStatus(S.mode === 'probe' ? '확인할 지점(건물·도로)을 클릭하세요. 다시 누르면 종료됩니다.' : '측정 종료'); }
    if (a === 'particles') S.particles = !S.particles;
    if (a === 'guide') { S.guide = !S.guide; drawHelpers(); }
    if (a === 'vground') viewGround();
    if (a === 'vair') viewAir();
    if (a === 'vtop') viewTop();
    if (a === 'clear') {
      S.A = null; S.pts = []; S.mode = 'idle'; invalidate(true);
      clearList(S.helpers); clearList(S.probes); updateAreaInfo();
      setStatus('[구역 지정]을 누른 뒤 ① 바다 위 지점, ② 물이 들어가는지 보고 싶은 도심 지점(여러 곳 가능)을 차례로 클릭하세요.');
    }
    refreshButtons();
  });
  setBearing(0, false); updateLegend(); refreshButtons();

  // 좌표로 구역 지정 (시험·재현용)
  // setArea(바다 경도, 바다 위도, [[도심 경도, 위도], ...], 바다 높이)  또는 예전 형식 setArea(경도1, 위도1, 경도2, 위도2, 높이)
  function setArea(lonA, latA, pts, h0 = 0, h0b) {
    if (typeof pts === 'number') { pts = [[pts, h0]]; h0 = h0b ?? 0; }
    S.A = { lon: lonA, lat: latA, h: h0, c: C3.fromDegrees(lonA, latA, h0) };
    S.pts = pts.map(([lo, la]) => ({ lon: lo, lat: la, h: 0, c: C3.fromDegrees(lo, la, 0) }));
    S.mode = 'idle'; S.bearingManual = false; invalidate(false); autoBearing(); drawHelpers(); refreshButtons();
    setStatus('구역 지정 완료. 방향을 확인한 뒤 [계산 실행]을 누르세요.');
  }
  // 이전 버전(같은 페이지)에서 설정·높이 자료·계산 결과 이어받기
  if (PREV && PREV.state && PREV.state.A) {
    try {
      const ps = PREV.state;
      S.A = ps.A; S.pts = (ps.pts || []).slice();
      for (const k of ['H', 'D', 'W', 'extra', 'seaPad', 'dur', 'speedMul']) if (typeof ps[k] === 'number') setSlider(k, ps[k]);
      S.prec = ps.prec || S.prec; S.baseAdj = ps.baseAdj || 0; $('input[data-k=baseAdj]').value = S.baseAdj;
      S.bearingManual = ps.bearingManual ?? true;
      setBearing(ps.bearing || 0, false);
      if (PREV.cap) { CAP = PREV.cap; if (CAP.Ah == null) CAP.Ah = ps.A.h; S.baseAuto = ps.baseAuto || 0; }
      if (PREV.grid && ps.done && PREV.grid.frames && PREV.grid.frames.length) {
        G = PREV.grid; S.tEnd = ps.tEnd; S.done = true; S.view = ps.view || 'max'; R = null; prim.dirty = true;
        seek(Math.min(ps.t || 0, G.tAvail)); renderSummary();
      }
      drawHelpers(); updateLegend(); refreshButtons();
      setStatus(G ? '새 버전으로 바뀌었습니다. 이전 계산 결과와 설정을 그대로 이어받았습니다.' : '새 버전으로 바뀌었습니다. 이전 구역·설정을 이어받았습니다. [계산 실행]을 누르세요.');
    } catch (e) { console.error('[tsunami] 이어받기 실패', e); }
  }
  window.__tsunami = {
    state: S, viewer, prim, setArea, setBearing: b => { S.bearingManual = true; setBearing(b); }, moveStart: (lon, lat, h) => moveStart({ lon, lat, h: h ?? S.A.h, c: C3.fromDegrees(lon, lat, h ?? S.A.h) }), nudgeStart, run: runCompute, seek, set: (k, v) => { setSlider(k, v); invalidate(false); drawHelpers(); }, _render: refreshRender,
    get grid() { return G; }, get cap() { return CAP; },
    destroy() {
      S.dead = true; cancelAnimationFrame(S.raf); S.running = false; S.computing = false;
      if (worker) { try { worker.terminate(); } catch (e) {} worker = null; }
      if (workerURL) { try { URL.revokeObjectURL(workerURL); } catch (e) {} }
      try { scene.primitives.remove(prim); } catch (e) {}
      try { prim.destroyGl(); } catch (e) {}
      rmErr && rmErr();
      clearList(S.helpers); clearList(S.probes); purgeNamed();
      canvas.removeEventListener('pointerdown', onDown, true); canvas.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointermove', onMove, true); window.removeEventListener('pointerup', onWinUp, true);
      if (drag) { try { ssc.enableInputs = drag.inputs; } catch (e) {} drag = null; }
      ghost.remove();
      panel.remove(); delete window.__tsunami;
    },
  };
})();
