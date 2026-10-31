var active_mouse_object;
var drag = {};
var mouse_objects = [];
function addMouseHandlers(object) {
  mouse_objects.push(object);
  if (mouse_objects.length > 1) return;

  function rendererXY(event) {
    return {
      x: event.clientX - window.innerWidth/2,
      y: window.innerHeight/2 - event.clientY
    };
  }

  function rayAtXY(point) {
    var position = new THREE.Vector3(point.x, point.y, 500),
        vector = new THREE.Vector3(0, 0, -1),
        ray = new THREE.Ray(position, vector);
    return ray;
  }

  document.addEventListener("mousedown", function(e){
    var click_pos = rendererXY(e),
        ray = rayAtXY(click_pos);

    mouse_objects.forEach(function(o){
      if (ray.intersectObject(o.mesh).length === 0) return;
      active_mouse_object = o;
      o.mesh.isActive = true;
      drag = {x:click_pos.x, y:click_pos.y};

      if (!o.click) return;
      if (!o.mesh) return;
      o.click.call(o.mesh, {x:click_pos.x, y:click_pos.y});
    });
  });

  document.addEventListener("mousemove", function(e){
    var click_pos = rendererXY(e),
        ray = rayAtXY(click_pos);

    mouse_objects.forEach(function(o){
      if (!o.onMouseMove) return;
      if (!o.mesh) return;
      if (ray.intersectObject(o.mesh).length === 0) return;

      o.onMouseMove({x:click_pos.x, y:click_pos.y});
    });

    if (!active_mouse_object) return;
    if (!active_mouse_object.drag) return;
    active_mouse_object.drag.call(
      active_mouse_object.mesh,
      {
        x:click_pos.x,
        y:click_pos.y,
        x_diff: click_pos.x - drag.x,
        y_diff: click_pos.y - drag.y
      }
    );
    drag = {x:click_pos.x, y:click_pos.y};
  });

  document.addEventListener("mouseup", function(e){
    active_mouse_object = null;
    mouse_objects.forEach(function(o){
      if (!o.mesh) return;
      o.mesh.isActive = false;
      if (!o.onMouseUp) return;
      o.onMouseUp();
    });
  });
}

var Mouse = {
  callbacks: {'drag': {}, 'click': {}},
  addEventListener: function(name, mesh, callback) {
    if (!this.callbacks.hasOwnProperty(name)) return;
    var handler = {};
    handler.mesh = mesh;
    handler[name] = callback;
    addMouseHandlers(handler);
  }
};

function extendPhysijsAddEventListener() {
  if (typeof(Physijs) == 'undefined') return setTimeout(extendPhysijsAddEventListener, 5);

  var pjs_ael = Physijs.ConvexMesh.prototype.addEventListener;
  Physijs.ConvexMesh.prototype.addEventListener = function(event_name, callback) {
    if (event_name == 'drag') Mouse.addEventListener('drag', this, callback);
    if (event_name == 'click') Mouse.addEventListener('click', this, callback);
    pjs_ael.call(this, event_name, callback);
  };
}
extendPhysijsAddEventListener();
