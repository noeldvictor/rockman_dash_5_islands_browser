package com.nttdocomo.ui.graphics3d.collision;

import com.nttdocomo.ui.graphics3d.Figure;
import com.nttdocomo.ui.util3d.Vector3D;

public interface CollisionObserver {
    void onHit(Shape a, Shape b, boolean hit, Vector3D point);

    boolean onHit(Shape shape, int count, BoundingVolume[] volumes, int[] indices, boolean[] hits, Vector3D[] points);

    void onHit(Shape shape, Sphere sphere, float time, Vector3D point, float distance);

    void onPick(Ray ray, Figure figure, IntersectionAttribute[] attributes);
}
