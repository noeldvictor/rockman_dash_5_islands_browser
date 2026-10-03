package com.nttdocomo.ui.graphics3d.collision;

public class Sphere extends AbstractBV {
    private float radius;

    public Sphere(float radius) {
        super(TYPE_SPHERE);
        set(radius);
    }

    public void set(float radius) {
        if (radius < 0f) {
            throw new IllegalArgumentException();
        }
        this.radius = radius;
    }

    public float getRadius() {
        return radius;
    }
}
