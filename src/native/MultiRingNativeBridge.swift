import Foundation
import React
import DHBleSDK     

@objc(MultiRingBridge)
class MultiRingBridge: NSObject {
  
  // MARK: - Shared Instance
  private let rwManager = RWRingManager()
  private let ycManager = YCRingManager() 
  
  
  @objc
  func supportedRings() -> [String] {
    return ["RW (RingWho)", "YC/X6 (YiCheng OEM)", "Circular", "RingConn", "Amazfit Helio"]
  }
  
  @objc
  func scanAllRings(_ resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
    let group = DispatchGroup()
    var results: [[String: Any]] = []
    var errors: [String] = []
    
    group.enter()
    rwManager.scanDevices({ devices in
      results += (devices as? [[String: Any]]) ?? []
      group.leave()
    }) { _, _, _ in
      errors.append("RW scan failed")
      group.leave()
    }
    
    group.enter()
    ycManager.scanDevices({ devices in
      results += devices
      group.leave()
    }) { error in
      errors.append("YC scan failed: \(error)")
      group.leave()
    }
    
    group.notify(queue: .main) {
      if !errors.isEmpty {
        reject("SCAN_FAILED", errors.joined(separator: "; "), nil)
      } else {
        resolve(results)
      }
    }
  }
  
  @objc
  func connectAnyRing(_ type: String, 
                      uuid: String,
                      resolve: @escaping RCTPromiseResolveBlock,
                      rejecter reject: @escaping RCTPromiseRejectBlock) {
    if type.contains("RW") || type.contains("RingWho") {
      rwManager.connectDevice(uuid: uuid, resolve: resolve, rejecter: reject)
    } else {
      ycManager.connectDevice(uuid: uuid, resolve: resolve, rejecter: reject)
    }
  }
  
  @objc
  func syncAllData(_ type: String,
                   uuid: String,
                   resolve: @escaping RCTPromiseResolveBlock,
                   rejecter reject: @escaping RCTPromiseRejectBlock) {
    if type.contains("RW") {
      rwManager.getAllHealthData(resolve: resolve, rejecter: reject)
    } else {
      ycManager.getAllHealthData(uuid: uuid, resolve: resolve, rejecter: reject)
    }
  }
  
  @objc
  func getBattery(_ type: String,
                  uuid: String,
                  resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: @escaping RCTPromiseRejectBlock) {
    if type.contains("RW") {
      rwManager.getBatteryLevel(resolve: resolve, rejecter: reject)
    } else {
      ycManager.getBatteryLevel(uuid: uuid, resolve: resolve, rejecter: reject)
    }
  }
}