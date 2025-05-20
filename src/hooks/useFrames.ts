import { useState, useEffect } from 'react';

export interface FrameCoordinates {
  x: string;
  y: string;
  name: string;
  screenshotWidth?: number;
  screenshotHeight?: number;
}

type DeviceVariant = FrameCoordinates | {
  [orientation in 'Portrait' | 'Landscape']?: FrameCoordinates;
};

type DeviceType = {
  [variant: string]: DeviceVariant | {
    [subVariant: string]: DeviceVariant;
  };
} | FrameCoordinates;

export interface FramesData {
  AppleDevice: { [device: string]: DeviceType };
  iPad: { [device: string]: DeviceType };
  Watch: { [device: string]: DeviceType };
  version: string;
}

export interface DeviceFrame {
  id: string;
  category: string;
  deviceType: string;
  model: string;
  variant?: string;
  version?: string;
  orientation?: 'Portrait' | 'Landscape';
  coordinates: FrameCoordinates;
}

function isFrameCoordinates(obj: unknown): obj is FrameCoordinates {
  return typeof obj === 'object' && obj !== null && 'x' in obj && 'y' in obj && 'name' in obj;
}

function isRecord(obj: unknown): obj is Record<string, unknown> {
  return typeof obj === 'object' && obj !== null;
}

function compareVersions(a: string, b: string): number {
  // Handle special cases for version ranges like "12-13"
  const normalizeVersion = (v: string) => {
    // If it's a range, take the first number
    const match = v.match(/^(\d+)(?:-\d+)?$/);
    return match ? parseInt(match[1]) : parseInt(v);
  };

  const numA = normalizeVersion(a);
  const numB = normalizeVersion(b);

  return numA - numB;
}

function flattenFramesData(data: FramesData): DeviceFrame[] {
  const frames: DeviceFrame[] = [];

  Object.entries(data).forEach(([category, devices]) => {
    if (category === 'version') return;

    Object.entries(devices).forEach(([deviceType, models]) => {
      if (isFrameCoordinates(models)) {
        // Handle simple device entries
        frames.push({
          id: `${category}-${deviceType}`,
          category,
          deviceType,
          model: deviceType,
          coordinates: models
        });
      } else if (isRecord(models)) {
        // Handle nested device variants
        Object.entries(models).forEach(([version, variants]) => {
          if (isFrameCoordinates(variants)) {
            // Handle version without variants (e.g., Mac > iMac > 2021)
            frames.push({
              id: `${category}-${deviceType}-${version}`,
              category,
              deviceType,
              model: deviceType,
              version,
              coordinates: variants
            });
          } else if (isRecord(variants)) {
            // First check if this is a version with direct coordinates
            const hasDirectCoordinates = Object.entries(variants).some(([key, value]) => 
              isFrameCoordinates(value) && (key === 'x' || key === 'y' || key === 'name')
            );

            if (hasDirectCoordinates && isFrameCoordinates(variants)) {
              // Handle version with direct coordinates
              frames.push({
                id: `${category}-${deviceType}-${version}`,
                category,
                deviceType,
                model: deviceType,
                version,
                coordinates: variants as FrameCoordinates
              });
            } else {
              // Handle versions with variants or nested structures
              Object.entries(variants).forEach(([variant, orientations]) => {
                if (isFrameCoordinates(orientations)) {
                  // Handle variant without orientation
                  frames.push({
                    id: `${category}-${deviceType}-${version}-${variant}`,
                    category,
                    deviceType,
                    model: deviceType,
                    version,
                    variant,
                    coordinates: orientations
                  });
                } else if (isRecord(orientations)) {
                  // Handle variants with orientations
                  Object.entries(orientations).forEach(([orientation, coords]) => {
                    if (isFrameCoordinates(coords)) {
                      frames.push({
                        id: `${category}-${deviceType}-${version}-${variant}-${orientation}`,
                        category,
                        deviceType,
                        model: deviceType,
                        version,
                        variant,
                        orientation: orientation as 'Portrait' | 'Landscape',
                        coordinates: coords
                      });
                    }
                  });
                }
              });
            }
          }
        });
      }
    });
  });

  return frames;
}

export function useFrames() {
  const [frames, setFrames] = useState<DeviceFrame[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadFrames() {
      try {
        const response = await fetch('/frames/Frames.json');
        if (!response.ok) {
          throw new Error('Failed to load frames configuration');
        }
        const data: FramesData = await response.json();
        const flattenedFrames = flattenFramesData(data);
        
        // Sort frames by version number
        flattenedFrames.sort((a, b) => {
          // First sort by category
          if (a.category !== b.category) {
            return a.category.localeCompare(b.category);
          }
          
          // Then by model
          if (a.model !== b.model) {
            return a.model.localeCompare(b.model);
          }
          
          // Then by version if both have versions
          if (a.version && b.version) {
            return compareVersions(a.version, b.version);
          }
          
          // Put items with versions after those without
          if (a.version) return 1;
          if (b.version) return -1;
          
          return 0;
        });

        setFrames(flattenedFrames);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load frames');
        setFrames([]);
      } finally {
        setIsLoading(false);
      }
    }

    loadFrames();
  }, []);

  return { frames, isLoading, error };
} 