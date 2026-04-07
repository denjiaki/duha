/**
 * GlassIsland — one refractive “glass” surface (kube.io-style SVG displacement + backdrop-filter).
 * Each instance gets unique filter IDs under a shared hidden <svg><defs>.
 */
(function (global) {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  let defsRoot = null;
  let idSeq = 0;

  function ensureDefs() {
    if (defsRoot) return defsRoot;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.setAttribute("aria-hidden", "true");
    const defs = document.createElementNS(SVG_NS, "defs");
    svg.appendChild(defs);
    (document.body || document.documentElement).appendChild(svg);
    defsRoot = defs;
    return defsRoot;
  }

  let cachedSvgBackdrop = null;
  /** Whether backdrop-filter accepts url(#svgFilter) in this browser (Chromium). */
  function supportsSvgBackdropFilter(filterId) {
    if (cachedSvgBackdrop !== null) return cachedSvgBackdrop;
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:absolute;visibility:hidden;pointer-events:none;-webkit-backdrop-filter:url(#" +
      filterId +
      ");backdrop-filter:url(#" +
      filterId +
      ")";
    document.documentElement.appendChild(probe);
    const style = getComputedStyle(probe);
    const v = style.webkitBackdropFilter || style.backdropFilter || "";
    document.documentElement.removeChild(probe);
    cachedSvgBackdrop = v.includes("url(");
    return cachedSvgBackdrop;
  }

  function sdfRoundBox(px, py, bx, by, r) {
    const qx = Math.abs(px) - bx;
    const qy = Math.abs(py) - by;
    return (
      Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
    );
  }

  function sdfToHalfExtents(width, height, cornerR) {
    const r = Math.min(cornerR, width / 2, height / 2);
    const bx = width / 2 - r;
    const by = height / 2 - r;
    return { bx, by, r };
  }

  function gradSdf(px, py, bx, by, rad) {
    const e = 0.8;
    const dx =
      sdfRoundBox(px + e, py, bx, by, rad) - sdfRoundBox(px - e, py, bx, by, rad);
    const dy =
      sdfRoundBox(px, py + e, bx, by, rad) - sdfRoundBox(px, py - e, bx, by, rad);
    const len = Math.hypot(dx, dy) || 1e-9;
    return [dx / len, dy / len];
  }

  const profiles = {
    convexCircle: function (u) {
      const x = Math.max(0, Math.min(1, u));
      return Math.sqrt(1 - (1 - x) * (1 - x));
    },
    convexSquircle: function (u) {
      const x = Math.max(0, Math.min(1, u));
      return Math.pow(1 - Math.pow(1 - x, 4), 0.25);
    },
  };

  function deriv(fn, u) {
    const e = 0.002;
    const a = Math.max(0, Math.min(1, u - e));
    const b = Math.max(0, Math.min(1, u + e));
    return (fn(b) - fn(a)) / (b - a + 1e-9);
  }

  class GlassIsland {
    /**
     * @param {Object} opts
     * @param {HTMLElement} opts.element — node that receives glass visuals + backdrop-filter
     * @param {string} [opts.fill] — CSS background (e.g. rgba / gradient)
     * @param {string} [opts.borderRadius] — optional CSS length; overrides computed corner radius for displacement
     * @param {string} [opts.radius] — alias for borderRadius
     * @param {number} [opts.bezelWidth=12] — refracting rim depth in CSS px (“glass edge”)
     * @param {number} [opts.thickness] — alias for bezelWidth if bezelWidth omitted
     * @param {number} [opts.refractionStrength=20] — displacement field intensity before normalisation
     * @param {number} [opts.displacementScale=12] — feDisplacementMap scale
     * @param {number} [opts.backdropBlur=1] — px, combined with refracting filter when supported
     * @param {number} [opts.backdropSaturate=160] — %, backdrop saturate
     * @param {string} [opts.boxShadow] — CSS box-shadow
     * @param {'convexCircle'|'convexSquircle'} [opts.profile='convexCircle']
     * @param {number} [opts.maxDevicePixelRatio=2] — cap for displacement texture size
     * @param {boolean} [opts.autoRefresh=true] — ResizeObserver + refresh on size change
     */
    constructor(opts) {
      if (!opts || !opts.element) {
        throw new Error("GlassIsland requires { element: HTMLElement }");
      }
      this.element = opts.element;
      this._options = {
        fill: opts.fill != null ? opts.fill : "rgba(255,255,255,0.18)",
        borderRadius:
          opts.borderRadius != null
            ? opts.borderRadius
            : opts.radius != null
              ? opts.radius
              : null,
        bezelWidth:
          opts.bezelWidth != null
            ? opts.bezelWidth
            : opts.thickness != null
              ? opts.thickness
              : 12,
        refractionStrength:
          opts.refractionStrength != null ? opts.refractionStrength : 20,
        displacementScale:
          opts.displacementScale != null ? opts.displacementScale : 12,
        backdropBlur: opts.backdropBlur != null ? opts.backdropBlur : 1,
        backdropSaturate:
          opts.backdropSaturate != null ? opts.backdropSaturate : 160,
        boxShadow: opts.boxShadow != null ? opts.boxShadow : "",
        profile:
          opts.profile && profiles[opts.profile]
            ? opts.profile
            : "convexCircle",
        maxDevicePixelRatio:
          opts.maxDevicePixelRatio != null ? opts.maxDevicePixelRatio : 2,
        autoRefresh: opts.autoRefresh !== false,
      };

      this._id = "gi-" + ++idSeq + "-" + Math.random().toString(36).slice(2, 8);
      this._filterId = this._id + "-disp";
      this._feImage = null;
      this._feDisp = null;
      this._observer = null;
      this._resizeTimer = null;
      this._destroyed = false;

      this._buildFilterSvg();
      if (supportsSvgBackdropFilter(this._filterId)) {
        this._refractSupported = true;
      } else {
        this._refractSupported = false;
      }

      this._applyStaticPresentation();
      this.refresh();

      if (this._options.autoRefresh) {
        this._observer = new ResizeObserver(() => this._debouncedRefresh());
        this._observer.observe(this.element);
      }
    }

    _buildFilterSvg() {
      const defs = ensureDefs();
      const filter = document.createElementNS(SVG_NS, "filter");
      filter.setAttribute("id", this._filterId);
      filter.setAttribute("x", "0");
      filter.setAttribute("y", "0");
      filter.setAttribute("width", "100%");
      filter.setAttribute("height", "100%");
      filter.setAttribute("filterUnits", "objectBoundingBox");
      filter.setAttribute("color-interpolation-filters", "sRGB");

      const feImage = document.createElementNS(SVG_NS, "feImage");
      feImage.setAttribute("result", "map");
      feImage.setAttribute("x", "0");
      feImage.setAttribute("y", "0");
      feImage.setAttribute("width", "1");
      feImage.setAttribute("height", "1");
      feImage.setAttribute("preserveAspectRatio", "none");
      feImage.setAttribute("href", "");

      const feDisp = document.createElementNS(SVG_NS, "feDisplacementMap");
      feDisp.setAttribute("in", "SourceGraphic");
      feDisp.setAttribute("in2", "map");
      feDisp.setAttribute("scale", String(this._options.displacementScale));
      feDisp.setAttribute("xChannelSelector", "R");
      feDisp.setAttribute("yChannelSelector", "G");

      filter.appendChild(feImage);
      filter.appendChild(feDisp);
      defs.appendChild(filter);

      this._feImage = feImage;
      this._feDisp = feDisp;
    }

    _applyStaticPresentation() {
      const el = this.element;
      el.style.background = this._options.fill;
      if (this._options.boxShadow) {
        el.style.boxShadow = this._options.boxShadow;
      }
      if (this._options.borderRadius != null) {
        el.style.borderRadius = this._options.borderRadius;
      }
    }

    _cornerRadiusPx() {
      if (this._options.borderRadius != null) {
        const tmp = document.createElement("div");
        tmp.style.cssText =
          "position:absolute;visibility:hidden;width:0;height:0;border-radius:" +
          this._options.borderRadius;
        document.documentElement.appendChild(tmp);
        const px = parseFloat(getComputedStyle(tmp).borderRadius) || 0;
        document.documentElement.removeChild(tmp);
        return px;
      }
      return parseFloat(getComputedStyle(this.element).borderRadius) || 0;
    }

    _buildDisplacementMapDataUrl() {
      const o = this._options;
      const dpr = Math.min(o.maxDevicePixelRatio, window.devicePixelRatio || 1);
      const cssW = this.element.clientWidth || 1;
      const cssH = this.element.clientHeight || 1;
      const w = Math.max(16, Math.round(cssW * dpr));
      const h = Math.max(16, Math.round(cssH * dpr));
      const cornerR = this._cornerRadiusPx() * dpr;
      const { bx, by, r } = sdfToHalfExtents(w, h, cornerR);
      const bezel = Math.min(
        Math.max(4, o.bezelWidth * dpr),
        Math.min(w, h) * 0.42
      );

      const heightFn = profiles[o.profile];
      const vecs = [];
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          const px = i + 0.5 - w / 2;
          const py = j + 0.5 - h / 2;
          const d = sdfRoundBox(px, py, bx, by, r);
          if (d > 0) {
            vecs.push(0, 0);
            continue;
          }
          const distIn = -d;
          const u = Math.min(distIn / bezel, 1);
          const du = deriv(heightFn, u);
          const [gx, gy] = gradSdf(px, py, bx, by, r);
          const mag = du * o.refractionStrength;
          vecs.push(-gx * mag, -gy * mag);
        }
      }

      let max = 0;
      for (let i = 0; i < vecs.length; i += 2) {
        const m = Math.hypot(vecs[i], vecs[i + 1]);
        if (m > max) max = m;
      }
      max = max || 1;

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      const img = ctx.createImageData(w, h);
      const data = img.data;
      for (let k = 0, p = 0; k < vecs.length; k += 2, p += 4) {
        let vx = vecs[k] / max;
        let vy = vecs[k + 1] / max;
        vx = Math.max(-1, Math.min(1, vx));
        vy = Math.max(-1, Math.min(1, vy));
        data[p] = Math.round(128 + vx * 127);
        data[p + 1] = Math.round(128 + vy * 127);
        data[p + 2] = 128;
        data[p + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      return canvas.toDataURL("image/png");
    }

    _applyBackdropFilters() {
      const o = this._options;
      const b = o.backdropBlur;
      const s = o.backdropSaturate;
      const fallback = "blur(" + b + "px) saturate(" + s + "%)";
      if (this._refractSupported) {
        const url = "url(#" + this._filterId + ") blur(" + b + "px) saturate(" + s + "%)";
        this.element.style.webkitBackdropFilter = url;
        this.element.style.backdropFilter = url;
      } else {
        this.element.style.webkitBackdropFilter = fallback;
        this.element.style.backdropFilter = fallback;
      }
    }

    _debouncedRefresh() {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => this.refresh(), 100);
    }

    /**
     * Recompute displacement texture and re-apply feDisplacementMap scale + backdrop chain.
     */
    refresh() {
      if (this._destroyed) return;
      const href = this._buildDisplacementMapDataUrl();
      if (this._feImage) this._feImage.setAttribute("href", href);
      if (this._feDisp) {
        this._feDisp.setAttribute("scale", String(this._options.displacementScale));
      }
      this._applyBackdropFilters();
    }

    /**
     * Shallow-merge options and update presentation + maps.
     * @param {Partial<constructor parameters>} patch
     */
    setOptions(patch) {
      if (this._destroyed) return;
      const next = this._options;
      if (patch.fill != null) next.fill = patch.fill;
      if (patch.borderRadius !== undefined) next.borderRadius = patch.borderRadius;
      else if (patch.radius !== undefined) next.borderRadius = patch.radius;
      if (patch.bezelWidth != null) next.bezelWidth = patch.bezelWidth;
      else if (patch.thickness != null) next.bezelWidth = patch.thickness;
      if (patch.refractionStrength != null) {
        next.refractionStrength = patch.refractionStrength;
      }
      if (patch.displacementScale != null) {
        next.displacementScale = patch.displacementScale;
      }
      if (patch.backdropBlur != null) next.backdropBlur = patch.backdropBlur;
      if (patch.backdropSaturate != null) {
        next.backdropSaturate = patch.backdropSaturate;
      }
      if (patch.boxShadow !== undefined) next.boxShadow = patch.boxShadow;
      if (patch.profile != null && profiles[patch.profile]) {
        next.profile = patch.profile;
      }
      if (patch.maxDevicePixelRatio != null) {
        next.maxDevicePixelRatio = patch.maxDevicePixelRatio;
      }
      this._applyStaticPresentation();
      this.refresh();
    }

    destroy() {
      if (this._destroyed) return;
      this._destroyed = true;
      if (this._observer) {
        this._observer.disconnect();
        this._observer = null;
      }
      clearTimeout(this._resizeTimer);
      const filterEl = document.getElementById(this._filterId);
      if (filterEl && filterEl.parentNode) filterEl.parentNode.removeChild(filterEl);
      this.element.style.backdropFilter = "";
      this.element.style.webkitBackdropFilter = "";
      this._feImage = null;
      this._feDisp = null;
    }

    /**
     * Probe once per document: SVG filters in backdrop-filter (Chromium).
     * @returns {boolean}
     */
    static get supportsRefractingBackdrop() {
      if (cachedSvgBackdrop !== null) {
        return cachedSvgBackdrop;
      }
      ensureDefs();
      const tempId = "gi-probe-" + Math.random().toString(36).slice(2);
      const defs = ensureDefs();
      const f = document.createElementNS(SVG_NS, "filter");
      f.setAttribute("id", tempId);
      const dummy = document.createElementNS(SVG_NS, "feGaussianBlur");
      dummy.setAttribute("in", "SourceGraphic");
      dummy.setAttribute("stdDeviation", "0");
      f.appendChild(dummy);
      defs.appendChild(f);
      const ok = supportsSvgBackdropFilter(tempId);
      defs.removeChild(f);
      return ok;
    }
  }

  global.GlassIsland = GlassIsland;
})(typeof window !== "undefined" ? window : globalThis);
