package com.nttdocomo.ui.graphics3d.collision;

import com.nttdocomo.ui.util3d.Vector3D;

public class Triangle extends AbstractShape {
    final Vector3D[] v = {new Vector3D(), new Vector3D(), new Vector3D()};
    private boolean backFace;

    public Triangle(Vector3D a, Vector3D b, Vector3D c) {
        super(TYPE_TRIANGLE);
        set(a, b, c);
    }

    public void set(Vector3D a, Vector3D b, Vector3D c) {
        v[0].set(a);
        v[1].set(b);
        v[2].set(c);
    }

    public Vector3D[] getVertices(boolean transformed) {
        Vector3D[] out = {new Vector3D(v[0]), new Vector3D(v[1]), new Vector3D(v[2])};
        if (transformed) {
            for (int i = 0; i < 3; i++) {
                transform.transVector(v[i], out[i]);
            }
        }
        return out;
    }

    public Vector3D getNormal(boolean transformed) {
        Vector3D[] p = getVertices(transformed);
        Vector3D e1 = new Vector3D(p[1].x - p[0].x, p[1].y - p[0].y, p[1].z - p[0].z);
        Vector3D e2 = new Vector3D(p[2].x - p[0].x, p[2].y - p[0].y, p[2].z - p[0].z);
        Vector3D n = new Vector3D();
        n.cross(e1, e2);
        n.normalize();
        return n;
    }

    public void setHittingFromBackFaceEnabled(boolean enabled) {
        backFace = enabled;
    }

    public boolean isHittingFromBackFaceEnabled() {
        return backFace;
    }
}
