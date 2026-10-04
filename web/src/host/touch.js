// On-screen controls: the phone-key buttons, a virtual analog stick, and swipe-to-look.
//
// The stick feeds the same path as a controller's left stick (Input.setStick), so it steers
// relative to the camera during play and acts as a d-pad in menus. Dragging a finger on the game
// itself turns the free-look camera, like dragging the mouse.

const SWIPE_YAW = 0.4; // degrees per CSS pixel
const SWIPE_PITCH = 0.3;

/**
 * @param {object} o
 * @param {import('./input.js').Input} o.input
 * @param {import('./camera.js').FreeCamera} o.camera
 * @param {HTMLElement} o.canvas  the game canvas
 * @param {HTMLElement} o.stick   the stick's base; its first child is the knob
 */
export function setupTouch({ input, camera, canvas, stick }) {
  const capture = (el, e) => {
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // not an active pointer (synthetic event): nothing to capture
    }
  };

  // buttons that hold a phone key while pressed (also the soft key labels under the game)
  for (const button of document.querySelectorAll('[data-key]')) {
    const key = Number(button.dataset.key);
    const source = `touch:${key}`;
    const up = () => {
      button.classList.remove('down');
      input.release(key, source);
    };
    button.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      capture(button, e);
      button.classList.add('down');
      input.press(key, source);
    });
    button.addEventListener('pointerup', up);
    button.addEventListener('pointercancel', up);
    button.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // virtual stick
  const knob = stick.firstElementChild;
  let stickPointer = null;
  const moveStick = (e) => {
    const r = stick.getBoundingClientRect();
    let x = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
    let y = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
    const m = Math.hypot(x, y);
    if (m > 1) {
      x /= m;
      y /= m;
    }
    knob.style.transform = `translate(${x * r.width * 0.28}px, ${y * r.height * 0.28}px)`;
    input.setStick(x, y);
  };
  const releaseStick = (e) => {
    if (e.pointerId !== stickPointer) return;
    stickPointer = null;
    knob.style.transform = '';
    input.setStick(0, 0);
  };
  stick.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    stickPointer = e.pointerId;
    capture(stick, e);
    moveStick(e);
  });
  stick.addEventListener('pointermove', (e) => {
    if (e.pointerId === stickPointer) moveStick(e);
  });
  stick.addEventListener('pointerup', releaseStick);
  stick.addEventListener('pointercancel', releaseStick);
  stick.addEventListener('contextmenu', (e) => e.preventDefault());

  // swipe on the game to look around
  const swipes = new Map(); // pointer id -> last position
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    swipes.set(e.pointerId, [e.clientX, e.clientY]);
    capture(canvas, e);
  });
  canvas.addEventListener('pointermove', (e) => {
    const last = swipes.get(e.pointerId);
    if (!last) return;
    if (camera.following) camera.look((e.clientX - last[0]) * SWIPE_YAW, (e.clientY - last[1]) * SWIPE_PITCH);
    last[0] = e.clientX;
    last[1] = e.clientY;
  });
  const endSwipe = (e) => swipes.delete(e.pointerId);
  canvas.addEventListener('pointerup', endSwipe);
  canvas.addEventListener('pointercancel', endSwipe);
}
