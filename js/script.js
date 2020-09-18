// Three.js - postprocessing - 3DLUT
// from https://threejsfundamentals.org/threejs/threejs-postprocessing-3dlut-identity.html

import * as THREE from 'https://threejsfundamentals.org/threejs/resources/threejs/r119/build/three.module.js';
import {OrbitControls} from 'https://threejsfundamentals.org/threejs/resources/threejs/r119/examples/jsm/controls/OrbitControls.js';
import {GLTFLoader} from 'https://threejsfundamentals.org/threejs/resources/threejs/r119/examples/jsm/loaders/GLTFLoader.js';
import {EffectComposer} from 'https://threejsfundamentals.org/threejs/resources/threejs/r119/examples/jsm/postprocessing/EffectComposer.js';
import {RenderPass} from 'https://threejsfundamentals.org/threejs/resources/threejs/r119/examples/jsm/postprocessing/RenderPass.js';
import {ShaderPass} from 'https://threejsfundamentals.org/threejs/resources/threejs/r119/examples/jsm/postprocessing/ShaderPass.js';
import {GUI} from 'https://threejsfundamentals.org/threejs/../3rdparty/dat.gui.module.js';

function main() {
  const canvas = document.querySelector('#c');
  const renderer = new THREE.WebGLRenderer({canvas});

  const fov = 45;
  const aspect = 2;  // the canvas default
  const near = 0.1;
  const far = 100;
  const camera = new THREE.PerspectiveCamera(fov, aspect, near, far);
  camera.position.set(0, 10, 20);

  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 5, 0);
  controls.update();

  const makeIdentityLutTexture = function() {
    const identityLUT = new Uint8Array([
        0,   0,   0, 255,  // black
      255,   0,   0, 255,  // red
        0,   0, 255, 255,  // blue
      255,   0, 255, 255,  // magenta
        0, 255,   0, 255,  // green
      255, 255,   0, 255,  // yellow
        0, 255, 255, 255,  // cyan
      255, 255, 255, 255,  // white
    ]);

    return function(filter) {
      const texture = new THREE.DataTexture(identityLUT, 4, 2, THREE.RGBAFormat);
      texture.minFilter = filter;
      texture.magFilter = filter;
      texture.needsUpdate = true;
      texture.flipY = false;
      return texture;
    };
  }();

  const lutTextures = [
    {
      name: 'identity',
      size: 2,
      filter: true,
      texture: makeIdentityLutTexture(THREE.LinearFilter),
    },
    {
      name: 'identity not filtered',
      size: 2,
      filter: false,
      texture: makeIdentityLutTexture(THREE.NearestFilter),
    },
  ];

  const lutNameIndexMap = {};
  lutTextures.forEach((info, ndx) => {
    lutNameIndexMap[info.name] = ndx;
  });

  const lutSettings = {
    lut: lutNameIndexMap.identity,
  };
  const gui = new GUI({ width: 300 });
  gui.add(lutSettings, 'lut', lutNameIndexMap);

  const scene = new THREE.Scene();

  const sceneBG = new THREE.Scene();
  const cameraBG = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);

  let bgMesh;
  let bgTexture;
  {
    const loader = new THREE.TextureLoader();
    bgTexture = loader.load('https://threejsfundamentals.org/threejs/resources/images/beach.jpg');
    const planeGeo = new THREE.PlaneBufferGeometry(2, 2);
    const planeMat = new THREE.MeshBasicMaterial({
      map: bgTexture,
      depthTest: false,
    });
    bgMesh = new THREE.Mesh(planeGeo, planeMat);
    sceneBG.add(bgMesh);
  }

  function frameArea(sizeToFitOnScreen, boxSize, boxCenter, camera) {
    const halfSizeToFitOnScreen = sizeToFitOnScreen * 0.5;
    const halfFovY = THREE.MathUtils.degToRad(camera.fov * .5);
    const distance = halfSizeToFitOnScreen / Math.tan(halfFovY);
    // compute a unit vector that points in the direction the camera is now
    // in the xz plane from the center of the box
    const direction = (new THREE.Vector3())
        .subVectors(camera.position, boxCenter)
        .multiply(new THREE.Vector3(1, 0, 1))
        .normalize();

    // move the camera to a position distance units way from the center
    // in whatever direction the camera was from the center already
    camera.position.copy(direction.multiplyScalar(distance).add(boxCenter));

    // pick some near and far values for the frustum that
    // will contain the box.
    camera.near = boxSize / 100;
    camera.far = boxSize * 100;

    camera.updateProjectionMatrix();

    // point the camera to look at the center of the box
    camera.lookAt(boxCenter.x, boxCenter.y, boxCenter.z);
  }

  {
    const gltfLoader = new GLTFLoader();
    gltfLoader.load('https://threejsfundamentals.org/threejs/resources/models/3dbustchallange_submission/scene.gltf', (gltf) => {
      const root = gltf.scene;
      scene.add(root);

      // fix materials from r114
      root.traverse(({material}) => {
        if (material) {
          material.depthWrite = true;
        }
      });

      root.updateMatrixWorld();
      // compute the box that contains all the stuff
      // from root and below
      const box = new THREE.Box3().setFromObject(root);

      const boxSize = box.getSize(new THREE.Vector3()).length();
      const boxCenter = box.getCenter(new THREE.Vector3());
      frameArea(boxSize * 0.4, boxSize, boxCenter, camera);

      // update the Trackball controls to handle the new size
      controls.maxDistance = boxSize * 10;
      controls.target.copy(boxCenter);
      controls.update();
    });
  }

  const lutShader = {
    uniforms: {
      tDiffuse: { value: null },  // the previous pass's result
      lutMap:  { value: null },
      lutMapSize: { value: 1, },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      }
    `,
    fragmentShader: `
      #include <common>

      #define FILTER_LUT true

      uniform sampler2D tDiffuse;
      uniform sampler2D lutMap;
      uniform float lutMapSize;

      varying vec2 vUv;

      vec4 sampleAs3DTexture(sampler2D tex, vec3 texCoord, float size) {
        float sliceSize = 1.0 / size;                  // space of 1 slice
        float slicePixelSize = sliceSize / size;       // space of 1 pixel
        float width = size - 1.0;
        float sliceInnerSize = slicePixelSize * width; // space of size pixels
        float zSlice0 = floor( texCoord.z * width);
        float zSlice1 = min( zSlice0 + 1.0, width);
        float xOffset = slicePixelSize * 0.5 + texCoord.x * sliceInnerSize;
        float yRange = (texCoord.y * width + 0.5) / size;
        float s0 = xOffset + (zSlice0 * sliceSize);

        #ifdef FILTER_LUT

          float s1 = xOffset + (zSlice1 * sliceSize);
          vec4 slice0Color = texture2D(tex, vec2(s0, yRange));
          vec4 slice1Color = texture2D(tex, vec2(s1, yRange));
          float zOffset = mod(texCoord.z * width, 1.0);
          return mix(slice0Color, slice1Color, zOffset);

        #else

          return texture2D(tex, vec2( s0, yRange));

        #endif
      }

      void main() {
        vec4 originalColor = texture2D(tDiffuse, vUv);
        gl_FragColor = sampleAs3DTexture(lutMap, originalColor.xyz, lutMapSize);
      }
    `,
  };

  const lutNearestShader = {
    uniforms: {...lutShader.uniforms},
    vertexShader: lutShader.vertexShader,
    fragmentShader: lutShader.fragmentShader.replace('#define FILTER_LUT', '//'),
  };

  const effectLUT = new ShaderPass(lutShader);
  effectLUT.renderToScreen = true;
  const effectLUTNearest = new ShaderPass(lutNearestShader);
  effectLUTNearest.renderToScreen = true;

  const renderModel = new RenderPass(scene, camera);
  renderModel.clear = false;  // so we don't clear out the background
  const renderBG = new RenderPass(sceneBG, cameraBG);

  renderModel.clear = false;

  const rtParameters = {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBFormat,
  };
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, rtParameters));

  composer.addPass(renderBG);
  composer.addPass(renderModel);
  composer.addPass(effectLUT);
  composer.addPass(effectLUTNearest);

  function resizeRendererToDisplaySize(renderer) {
    const canvas = renderer.domElement;
    const width = canvas.clientWidth * window.devicePixelRatio | 0;
    const height = canvas.clientHeight * window.devicePixelRatio | 0;

    const needResize = canvas.width !== width || canvas.height !== height;
    if (needResize) {
      renderer.setSize(width, height, false);
    }
    return needResize;
  }

  let then = 0;
  function render(now) {
    now *= 0.001;  // convert to seconds
    const delta = now - then;
    then = now;

    if (resizeRendererToDisplaySize(renderer)) {
      const canvas = renderer.domElement;
      const canvasAspect = canvas.clientWidth / canvas.clientHeight;
      camera.aspect = canvasAspect;
      camera.updateProjectionMatrix();
      composer.setSize(canvas.width, canvas.height);

      // scale the background plane to keep the image's
      // aspect correct.
      // Note the image may not have loaded yet.
      const imageAspect = bgTexture.image ? bgTexture.image.width / bgTexture.image.height : 1;
      const aspect = imageAspect / canvasAspect;
      bgMesh.scale.x = aspect > 1 ? aspect : 1;
      bgMesh.scale.y = aspect > 1 ? 1 : 1 / aspect;
    }

    const lutInfo = lutTextures[lutSettings.lut];

    const effect = lutInfo.filter ? effectLUT : effectLUTNearest;
    effectLUT.enabled = lutInfo.filter;
    effectLUTNearest.enabled = !lutInfo.filter;

    const lutTexture = lutInfo.texture;
    effect.uniforms.lutMap.value = lutTexture;
    effect.uniforms.lutMapSize.value = lutInfo.size;

    composer.render(delta);

    requestAnimationFrame(render);
  }

  requestAnimationFrame(render);
}

main();
