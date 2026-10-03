package com.nttdocomo.ui.graphics3d.collision;

public interface Shape {
    int TYPE_POINT = 1;
    int TYPE_LINE = 2;
    int TYPE_RAY = 3;
    int TYPE_TRIANGLE = 4;
    int TYPE_PLANE = 5;
    int TYPE_SPHERE = 6;

    int getShapeType();
}
