package com.nttdocomo.ui.graphics3d.collision;

import com.nttdocomo.ui.util3d.Vector3D;

/**
 * Collision queries. The game only uses the swept test: a sphere moving in a straight line from
 * its current centre to a destination point, against a static triangle or sphere.
 */
public class Collision {
    private CollisionObserver observer;

    // result of the last sweep
    private float hitT;
    private float hx, hy, hz;

    public Collision() {
    }

    public void setObserver(CollisionObserver observer) {
        this.observer = observer;
    }

    /**
     * @param shape  static shape (triangle or sphere), positioned by its own transform
     * @param sphere moving sphere; its transform's translation is the start centre
     * @param dest   centre of the sphere at the end of the move
     * @param detail when true the observer is told the fraction of the move completed at impact,
     *               the contact point, and the distance travelled to impact
     */
    public boolean isHit(Shape shape, Sphere sphere, Vector3D dest, boolean detail) {
        float[] sm = sphere.transform.m;
        float sx = sm[3], sy = sm[7], sz = sm[11];
        float vx = dest.x - sx, vy = dest.y - sy, vz = dest.z - sz;
        float r = sphere.getRadius();
        boolean hit;
        if (shape instanceof Triangle) {
            Vector3D[] p = ((Triangle) shape).getVertices(true);
            hit = sweepTriangle(sx, sy, sz, vx, vy, vz, r, p[0], p[1], p[2]);
        } else if (shape instanceof Sphere) {
            Sphere s = (Sphere) shape;
            float[] m = s.transform.m;
            hitT = 2f;
            hit = sweepPoint(sx, sy, sz, vx, vy, vz, r + s.getRadius(), m[3], m[7], m[11]);
            if (hit) {
                // contact point lies on the static sphere, towards the moving one
                float cx = sx + vx * hitT, cy = sy + vy * hitT, cz = sz + vz * hitT;
                float dx = cx - m[3], dy = cy - m[7], dz = cz - m[11];
                float len = (float) Math.sqrt(dx * dx + dy * dy + dz * dz);
                float k = len > 0f ? s.getRadius() / len : 0f;
                hx = m[3] + dx * k;
                hy = m[7] + dy * k;
                hz = m[11] + dz * k;
            }
        } else {
            return false;
        }
        if (hit && observer != null) {
            float len = (float) Math.sqrt(vx * vx + vy * vy + vz * vz);
            observer.onHit(shape, sphere, hitT, new Vector3D(hx, hy, hz), hitT * len);
        }
        return hit;
    }

    public boolean isHit(Shape a, Shape b, boolean detail) {
        if (a instanceof Sphere && b instanceof Sphere) {
            float[] m = ((Sphere) a).transform.m;
            float[] n = ((Sphere) b).transform.m;
            float dx = m[3] - n[3], dy = m[7] - n[7], dz = m[11] - n[11];
            float r = ((Sphere) a).getRadius() + ((Sphere) b).getRadius();
            return dx * dx + dy * dy + dz * dz <= r * r;
        }
        return false;
    }

    /** Smallest root of a*t^2 + b*t + c = 0 in [0, max], or -1. */
    private static float lowestRoot(float a, float b, float c, float max) {
        float det = b * b - 4f * a * c;
        if (det < 0f || a == 0f) {
            return -1f;
        }
        float sq = (float) Math.sqrt(det);
        float r1 = (-b - sq) / (2f * a);
        float r2 = (-b + sq) / (2f * a);
        if (r1 > r2) {
            float t = r1;
            r1 = r2;
            r2 = t;
        }
        if (r1 >= 0f && r1 <= max) {
            return r1;
        }
        if (r2 >= 0f && r2 <= max) {
            return r2;
        }
        return -1f;
    }

    private boolean sweepPoint(float sx, float sy, float sz, float vx, float vy, float vz, float r,
            float px, float py, float pz) {
        float dx = sx - px, dy = sy - py, dz = sz - pz;
        float c = dx * dx + dy * dy + dz * dz - r * r;
        float t;
        if (c <= 0f) {
            // already touching: only a hit when moving further in
            if (dx * vx + dy * vy + dz * vz >= 0f) {
                return false;
            }
            t = 0f;
        } else {
            float a = vx * vx + vy * vy + vz * vz;
            float b = 2f * (vx * dx + vy * dy + vz * dz);
            t = lowestRoot(a, b, c, 1f);
            if (t < 0f) {
                return false;
            }
        }
        if (t < hitT) {
            hitT = t;
            hx = px;
            hy = py;
            hz = pz;
            return true;
        }
        return false;
    }

    private boolean sweepEdge(float sx, float sy, float sz, float vx, float vy, float vz, float r,
            Vector3D p1, Vector3D p2) {
        float ex = p2.x - p1.x, ey = p2.y - p1.y, ez = p2.z - p1.z;
        float bx = p1.x - sx, by = p1.y - sy, bz = p1.z - sz;
        float e2 = ex * ex + ey * ey + ez * ez;
        float ev = ex * vx + ey * vy + ez * vz;
        float eb = ex * bx + ey * by + ez * bz;
        float v2 = vx * vx + vy * vy + vz * vz;
        float a = e2 * -v2 + ev * ev;
        float b = e2 * (2f * (vx * bx + vy * by + vz * bz)) - 2f * ev * eb;
        float c = e2 * (r * r - (bx * bx + by * by + bz * bz)) + eb * eb;
        float t = lowestRoot(a, b, c, 1f);
        if (t < 0f || t >= hitT) {
            return false;
        }
        float f = (ev * t - eb) / e2;
        if (f < 0f || f > 1f) {
            return false;
        }
        hitT = t;
        hx = p1.x + ex * f;
        hy = p1.y + ey * f;
        hz = p1.z + ez * f;
        return true;
    }

    private boolean sweepTriangle(float sx, float sy, float sz, float vx, float vy, float vz, float r,
            Vector3D p0, Vector3D p1, Vector3D p2) {
        float e1x = p1.x - p0.x, e1y = p1.y - p0.y, e1z = p1.z - p0.z;
        float e2x = p2.x - p0.x, e2y = p2.y - p0.y, e2z = p2.z - p0.z;
        float nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
        float nl = (float) Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (nl == 0f) {
            return false;
        }
        nx /= nl;
        ny /= nl;
        nz /= nl;
        float dist = nx * (sx - p0.x) + ny * (sy - p0.y) + nz * (sz - p0.z);
        if (dist < 0f) {
            // treat the triangle as two-sided: work on the side the sphere starts on
            nx = -nx;
            ny = -ny;
            nz = -nz;
            dist = -dist;
        }
        float nv = nx * vx + ny * vy + nz * vz;
        if (nv >= 0f) {
            return false; // moving parallel to or away from the surface
        }
        float t0 = (r - dist) / nv;
        float t1 = (-r - dist) / nv;
        if (t0 > 1f || t1 < 0f) {
            return false;
        }
        if (t0 < 0f) {
            t0 = 0f;
        }
        hitT = 2f;
        // contact inside the face
        float cx = sx + vx * t0 - nx * r, cy = sy + vy * t0 - ny * r, cz = sz + vz * t0 - nz * r;
        if (dist <= r) {
            cx = sx - nx * dist;
            cy = sy - ny * dist;
            cz = sz - nz * dist;
        }
        if (inside(cx, cy, cz, p0, e1x, e1y, e1z, e2x, e2y, e2z)) {
            hitT = t0;
            hx = cx;
            hy = cy;
            hz = cz;
            return true;
        }
        boolean hit = sweepPoint(sx, sy, sz, vx, vy, vz, r, p0.x, p0.y, p0.z);
        hit |= sweepPoint(sx, sy, sz, vx, vy, vz, r, p1.x, p1.y, p1.z);
        hit |= sweepPoint(sx, sy, sz, vx, vy, vz, r, p2.x, p2.y, p2.z);
        hit |= sweepEdge(sx, sy, sz, vx, vy, vz, r, p0, p1);
        hit |= sweepEdge(sx, sy, sz, vx, vy, vz, r, p1, p2);
        hit |= sweepEdge(sx, sy, sz, vx, vy, vz, r, p2, p0);
        return hit;
    }

    private static boolean inside(float px, float py, float pz, Vector3D p0,
            float e1x, float e1y, float e1z, float e2x, float e2y, float e2z) {
        float qx = px - p0.x, qy = py - p0.y, qz = pz - p0.z;
        float d11 = e1x * e1x + e1y * e1y + e1z * e1z;
        float d12 = e1x * e2x + e1y * e2y + e1z * e2z;
        float d22 = e2x * e2x + e2y * e2y + e2z * e2z;
        float dq1 = qx * e1x + qy * e1y + qz * e1z;
        float dq2 = qx * e2x + qy * e2y + qz * e2z;
        float den = d11 * d22 - d12 * d12;
        if (den == 0f) {
            return false;
        }
        float u = (d22 * dq1 - d12 * dq2) / den;
        float v = (d11 * dq2 - d12 * dq1) / den;
        return u >= 0f && v >= 0f && u + v <= 1f;
    }
}
