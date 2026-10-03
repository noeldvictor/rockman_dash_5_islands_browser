package com.nttdocomo.ui.graphics3d;

import com.nttdocomo.ui.util3d.Transform;

public interface Graphics3D {
    void setClipRectFor3D(int x, int y, int w, int h);

    void setParallelView(int w, int h);

    void setPerspectiveView(float near, float far, int w, int h);

    void setPerspectiveView(float near, float far, float angle);

    void flushBuffer();

    void setTransform(Transform t);

    void addLight(Light light, Transform t);

    void resetLights();

    void setFog(Fog fog);

    void renderObject3D(DrawableObject3D obj, Transform t);
}
