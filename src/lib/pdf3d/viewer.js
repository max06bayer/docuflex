import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/**
 * Interactive WebGL view of a decoded PRC model. Drag to rotate, right-drag
 * or shift-drag to pan, scroll to zoom. Cameras follow the PDF 3D view
 * convention: C2W maps camera space to world, with the camera looking along
 * its z axis and its y axis pointing up on screen (checked against the
 * posters Acrobat renders for the same views).
 */

/** @typedef {import('./prc.js').PrcModel} PrcModel */
/** @typedef {import('./pdf-3d.js').Pdf3dView} Pdf3dView */

/** PDF and PRC colors are sRGB. @param {number[]} rgb */
const srgb = (rgb) => new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
const DEFAULT_COLOR = srgb([0.75, 0.75, 0.75]);

/** @param {PrcModel} model */
export function buildScene(model) {
  const root = new THREE.Group();
  /** @type {Map<string, THREE.Material>} */
  const materials = new Map();
  /** @param {number} styleIndex @param {'mesh' | 'lines' | 'points'} kind */
  const material = (styleIndex, kind) => {
    const key = `${kind}:${styleIndex}`;
    const cached = materials.get(key);
    if (cached) return cached;
    const style = model.styles[styleIndex];
    const color = style ? srgb(style.color) : DEFAULT_COLOR;
    const opacity = style?.opacity ?? 1;
    const transparent = opacity < 0.999;
    /** @type {THREE.Material} */
    let created;
    if (kind === 'mesh') {
      created = new THREE.MeshPhongMaterial({
        color,
        opacity,
        transparent,
        depthWrite: !transparent,
        side: THREE.DoubleSide,
        shininess: 12,
        specular: srgb([0.08, 0.08, 0.08])
      });
    } else if (kind === 'lines') created = new THREE.LineBasicMaterial({ color, opacity, transparent });
    else created = new THREE.PointsMaterial({ color, size: 3, sizeAttenuation: false, opacity, transparent });
    materials.set(key, created);
    return created;
  };

  for (const item of model.items) {
    const matrix = new THREE.Matrix4().fromArray(item.matrix);
    if (item.points?.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(item.points, 3));
      const points = new THREE.Points(geometry, material(item.style, 'points'));
      points.applyMatrix4(matrix);
      root.add(points);
      continue;
    }
    const tessellation = model.tessellations[item.tessellation];
    if (!tessellation || tessellation.kind === 'other') continue;
    if (tessellation.kind === 'lines') {
      if (!tessellation.positions.length) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(tessellation.positions, 3));
      const lines = new THREE.LineSegments(geometry, material(item.style, 'lines'));
      lines.applyMatrix4(matrix);
      root.add(lines);
      continue;
    }
    const { triangles } = tessellation;
    if (!triangles.positions.length) continue;
    // Split by per-triangle style so each group gets its own material.
    /** @type {Map<number, number[]>} */
    const groups = new Map();
    const triangleCount = triangles.positions.length / 9;
    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      const faceStyle = triangles.faceStyles?.[triangle] ?? -1;
      const style = faceStyle >= 0 && model.styles[faceStyle] ? faceStyle : item.style;
      const list = groups.get(style) ?? [];
      list.push(triangle);
      groups.set(style, list);
    }
    for (const [style, list] of groups) {
      const geometry = new THREE.BufferGeometry();
      const pick = (/** @type {Float32Array} */ source) => {
        if (list.length === triangleCount) return source;
        const out = new Float32Array(list.length * 9);
        list.forEach((triangle, index) => out.set(source.subarray(triangle * 9, triangle * 9 + 9), index * 9));
        return out;
      };
      geometry.setAttribute('position', new THREE.BufferAttribute(pick(triangles.positions), 3));
      if (triangles.normals) geometry.setAttribute('normal', new THREE.BufferAttribute(pick(triangles.normals), 3));
      else geometry.computeVertexNormals();
      if (triangles.colors) geometry.setAttribute('color', new THREE.BufferAttribute(pick(triangles.colors), 3));
      let meshMaterial = material(style, 'mesh');
      if (triangles.colors) {
        meshMaterial = meshMaterial.clone();
        /** @type {THREE.MeshPhongMaterial} */ (meshMaterial).vertexColors = true;
        /** @type {THREE.MeshPhongMaterial} */ (meshMaterial).color = srgb([1, 1, 1]);
      }
      const mesh = new THREE.Mesh(geometry, meshMaterial);
      mesh.applyMatrix4(matrix);
      root.add(mesh);
    }
  }
  return root;
}

export class Pdf3dViewer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {PrcModel} model
   * @param {Pdf3dView | null} view
   */
  constructor(canvas, model, view) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene = new THREE.Scene();
    this.content = buildScene(model);
    this.scene.add(this.content);
    this.bounds = new THREE.Box3().setFromObject(this.content);
    if (this.bounds.isEmpty()) this.bounds.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    this.sphere = this.bounds.getBoundingSphere(new THREE.Sphere());
    if (this.sphere.radius <= 0) this.sphere.radius = 1;

    this.perspective = new THREE.PerspectiveCamera(30, 1, 0.1, 1000);
    this.orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    /** @type {THREE.PerspectiveCamera | THREE.OrthographicCamera} */
    this.camera = this.perspective;
    /** Visible world height for the orthographic camera at zoom 1. */
    this.orthoHeight = this.sphere.radius * 2;
    /** @type {Pdf3dView | null} */
    this.view = view;
    /** Views without their own background keep the opening view's. */
    this.defaultBackground = view?.background ?? [1, 1, 1];
    this.fovBinding = 'W';
    this.baseFov = 30;

    this.scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    // Headlamp: a light that rides with the camera, like Acrobat's default.
    this.headlamp = new THREE.DirectionalLight(0xffffff, 1.9);
    this.headlamp.position.set(0.15, 0.25, 1);
    this.perspective.add(this.headlamp);
    this.perspective.add(this.headlamp.target);
    this.scene.add(this.perspective);
    this.orthoLamp = this.headlamp.clone();
    this.orthographic.add(this.orthoLamp);
    this.orthographic.add(this.orthoLamp.target);
    this.scene.add(this.orthographic);

    /** @type {OrbitControls | null} */
    this.controls = null;
    /** @type {number | undefined} */
    this.orthoSpan = undefined;
    this.width = 0;
    this.height = 0;
    this.pixelRatio = 0;
    this.frame = 0;
    this.needsRender = true;
    this.disposed = false;
    /** @type {{ position: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3 } | null} */
    this.home = null;
    this.applyView(view);
    this.loop = this.loop.bind(this);
    this.frame = requestAnimationFrame(this.loop);
  }

  /** @param {Pdf3dView | null} view */
  applyView(view) {
    const background = view?.background ?? this.defaultBackground;
    this.scene.background = srgb(background);
    const projection = view?.projection;
    const useOrthographic = Boolean(projection?.orthographic);
    this.camera = useOrthographic ? this.orthographic : this.perspective;
    this.fovBinding = projection?.binding ?? 'W';
    this.baseFov = projection?.fov && projection.fov > 0 && projection.fov < 179 ? projection.fov : 30;

    const center = this.sphere.center.clone();
    let position;
    let target;
    let up;
    const matrix = view?.cameraToWorld;
    if (matrix) {
      const y = new THREE.Vector3(matrix[3], matrix[4], matrix[5]);
      const z = new THREE.Vector3(matrix[6], matrix[7], matrix[8]).normalize();
      position = new THREE.Vector3(matrix[9], matrix[10], matrix[11]);
      const distance = view?.centerOfOrbit && view.centerOfOrbit > 0
        ? view.centerOfOrbit
        : Math.max(position.distanceTo(center), this.sphere.radius);
      target = position.clone().addScaledVector(z, distance);
      up = y.normalize();
    } else {
      // No stored camera: look at the model from the front-right, slightly above.
      const direction = new THREE.Vector3(1, -1.4, 0.9).normalize();
      target = center;
      position = center.clone().addScaledVector(direction, this.fitDistance());
      up = new THREE.Vector3(0, 0, 1);
    }
    this.camera.up.copy(up);
    this.camera.position.copy(position);
    this.camera.lookAt(target);
    if (useOrthographic) {
      // OS is the camera-to-view scale; with the binding dimension spanning the
      // view, 1 / OS world units are visible across it.
      const span = projection?.scale && projection.scale > 0 ? 1 / projection.scale : this.sphere.radius * 2.4;
      this.orthoSpan = span;
      this.orthographic.zoom = 1;
    }
    // OrbitControls orbits around camera.up, which it reads only when created.
    this.controls?.dispose();
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true;
    this.controls.target.copy(target);
    this.controls.addEventListener('change', () => {
      this.needsRender = true;
    });
    this.controls.update();
    this.home = { position: position.clone(), target: target.clone(), up: up.clone() };
    this.width = 0;
    this.needsRender = true;
  }

  fitDistance() {
    const fov = THREE.MathUtils.degToRad(Math.min(this.baseFov || 30, 60));
    return (this.sphere.radius / Math.sin(fov / 2)) * 1.1;
  }

  /** Recenters on the whole model, keeping the current direction. */
  fit() {
    const controls = /** @type {OrbitControls} */ (this.controls);
    const direction = this.camera.position.clone().sub(controls.target).normalize();
    if (direction.lengthSq() === 0) direction.set(0, -1, 0);
    controls.target.copy(this.sphere.center);
    this.camera.position.copy(this.sphere.center).addScaledVector(direction, this.fitDistance());
    if (this.camera === this.orthographic) {
      this.orthoSpan = this.sphere.radius * 2.4;
      this.orthographic.zoom = 1;
    }
    this.width = 0;
    controls.update();
    this.needsRender = true;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(this.canvas.clientWidth || rect.width));
    const height = Math.max(1, Math.round(this.canvas.clientHeight || rect.height));
    // CSS zoom on an ancestor scales the canvas on screen; render at that size.
    const screenScale = this.canvas.clientWidth ? rect.width / this.canvas.clientWidth : 1;
    const pixelRatio = Math.min((window.devicePixelRatio || 1) * screenScale, 3);
    if (width === this.width && height === this.height && pixelRatio === this.pixelRatio) return;
    this.width = width;
    this.height = height;
    this.pixelRatio = pixelRatio;
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    const aspect = width / height;
    // PDF fields of view apply to the width, height, or smaller/larger side.
    const binding = this.fovBinding;
    const horizontal = binding === 'W' || (binding === 'Min' && width < height) || (binding === 'Max' && width >= height);
    const fov = THREE.MathUtils.degToRad(this.baseFov);
    this.perspective.fov = horizontal ? THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(fov / 2) / aspect)) : this.baseFov;
    this.perspective.aspect = aspect;
    const span = this.orthoSpan ?? this.sphere.radius * 2.4;
    const halfWidth = horizontal ? span / 2 : (span / 2) * aspect;
    const halfHeight = horizontal ? span / 2 / aspect : span / 2;
    Object.assign(this.orthographic, { left: -halfWidth, right: halfWidth, top: halfHeight, bottom: -halfHeight });
    this.needsRender = true;
  }

  updateClipping() {
    const distance = this.camera.position.distanceTo(this.sphere.center);
    const radius = this.sphere.radius;
    const near = Math.max(distance - radius * 1.5, radius / 2000, 1e-6);
    const far = distance + radius * 1.5;
    if (this.camera === this.orthographic) {
      // Orthographic depth has no precision falloff, so clip generously.
      this.orthographic.near = distance - radius * 4;
      this.orthographic.far = distance + radius * 4;
    } else {
      this.perspective.near = near;
      this.perspective.far = far;
    }
    this.camera.updateProjectionMatrix();
  }

  loop() {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.loop);
    this.resize();
    if (this.controls?.update()) this.needsRender = true;
    if (!this.needsRender) return;
    this.needsRender = false;
    this.updateClipping();
    this.renderer.render(this.scene, this.camera);
  }

  /** @param {Pdf3dView | null} view */
  setView(view) {
    this.view = view;
    this.applyView(view);
  }

  reset() {
    this.applyView(this.view);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.controls?.dispose();
    this.scene.traverse((/** @type {THREE.Object3D} */ object) => {
      const mesh = /** @type {THREE.Mesh} */ (object);
      mesh.geometry?.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
      else material?.dispose();
    });
    this.renderer.dispose();
  }
}
