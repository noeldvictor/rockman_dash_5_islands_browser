package com.nttdocomo.ui.graphics3d.collision;

import com.nttdocomo.ui.util3d.Transform;

public abstract class AbstractShape implements Shape {
    private final int shapeType;
    final Transform transform = new Transform();
    private Object attribute;

    AbstractShape(int shapeType) {
        this.shapeType = shapeType;
    }

    public final int getShapeType() {
        return shapeType;
    }

    public final void setTransform(Transform t) {
        if (t == null) {
            transform.setIdentity();
        } else {
            transform.set(t);
        }
    }

    public final void setAttribute(Object o) {
        attribute = o;
    }

    public final Object getAttribute() {
        return attribute;
    }
}
