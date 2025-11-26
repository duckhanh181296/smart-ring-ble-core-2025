import Foundation
import React
import DHBleSDK 

@objc(RingWhoBridge)
class RingWhoBridge: NSObject, DHBleConnectDelegate {
  
  // Shared instances
  private let connectManager = ConnectManager()
  lazy var scanManager = ScanManager(connectManager: connectManager)
  
  // Discovered devices cache
  private var foundDevices: [String: [String: Any]] = [:]
  private var peripheralModels: [String: DHPeripheralModel] = [:]
  
  // Scan state
  private var scanResolve: RCTPromiseResolveBlock?
  private var scanReject: RCTPromiseRejectBlock?
  private var scanTimer: Timer?
  
  // Connection state
  private static let connectionQueue = DispatchQueue(label: "com.khanhduc.rw.connection")
  private static var isConnecting = false
  private static var currentConnectingDeviceId: String? = nil
  
  
  @objc static func requiresMainQueueSetup() -> Bool { true }
  
  
  @objc
  func initSDK(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    resolve(true)
  }
  
  
  @objc
  func scanDevices(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    if scanTimer != nil {
      reject("SCAN_IN_PROGRESS", "Scan is already running", nil)
      return
    }
    
    if DHBleCentralManager.isPoweredOff() {
      reject("BLUETOOTH_OFF", "Bluetooth is off", nil)
      return
    }
    
    foundDevices = [:]
    peripheralModels = [:]
    scanResolve = resolve
    scanReject = reject
    
    let manager = DHBleCentralManager.shareInstance()
    manager.connectDelegate = self
    DHBleCentralManager.startScan()
    
    scanTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { [weak self] _ in
      self?.finishScan()
    }
  }
  
  @objc
  func stopScan() {
    DHBleCentralManager.stopScan()
    scanTimer?.invalidate()
    scanTimer = nil
  }
  
  private func finishScan() {
    DHBleCentralManager.stopScan()
    scanTimer?.invalidate()
    scanTimer = nil
    
    let result = Array(foundDevices.values)
    scanResolve?(result)
    scanResolve = nil
    scanReject = nil
  }
  
  func centralManagerDidDiscoverPeripheral(_ peripherals: [DHPeripheralModel]) {
    for device in peripherals {
      let uuid = device.uuid
      peripheralModels[uuid] = device
      
      foundDevices[uuid] = [
        "name": device.name,
        "uuid": uuid,
        "macAddr": device.macAddr,
        "rssi": device.rssi
      ]
    }
  }
  
  
  @objc
  func connectDevice(_ uuid: String, resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let peripheral = peripheralModels[uuid] else {
      reject("DEVICE_NOT_FOUND", "Không thấy device với UUID này", nil)
      return
    }
    
    Self.connectionQueue.sync {
      if Self.isConnecting {
        reject("CONNECTION_IN_PROGRESS", "Đang kết nối device khác", nil)
        return
      }
      Self.isConnecting = true
      Self.currentConnectingDeviceId = uuid
    }
    
    let manager = DHBleCentralManager.shareInstance()
    manager.connectDelegate = self
    DHBleCentralManager.connectDevice(with: peripheral)
    
    self.connectResolve = resolve
    self.connectReject = reject
  }
  
  func centralManagerDidConnect(_ peripheral: CBPeripheral) {
    connectResolve?(["state": "connected"])
    resetConnectionState()
  }
  
  func centralManagerDidDisconnectPeripheral(_ peripheral: CBPeripheral) {
    connectReject?("CONNECT_FAILED", "Kết nối thất bại hoặc ngắt", nil)
    resetConnectionState()
  }
  
  private func resetConnectionState() {
    Self.connectionQueue.sync {
      Self.isConnecting = false
      Self.currentConnectingDeviceId = nil
    }
  }
  
  @objc
  func disconnectDevice(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    DHBleCentralManager.disconnectDevice()
    resolve(["state": "disconnected"])
  }
  
  
  @objc
  func getBatteryLevel(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    DHBleCommand.getBattery { code, data in
      if code == 0, let info = data as? DHBatteryInfoModel {
        resolve([
          "battery": info.battery,
          "status": info.status,
          "isLow": info.isLower
        ])
      } else {
        reject("BATTERY_FAILED", "Không lấy được pin", nil)
      }
    }
  }
  
  // MARK: - Health Data Sync
  
  @objc
  func getAllHealthData(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    let result = NSMutableDictionary()
    var isResolved = false
    var hasData = false
    let maxTimeout: TimeInterval = 10
    let partialTimeout: TimeInterval = 2
    var lastReceiveTime = Date()

    func checkPartialTimeout() {
      if hasData && Date().timeIntervalSince(lastReceiveTime) >= partialTimeout && !isResolved {
        isResolved = true
        resolve(result.copy() as! NSDictionary)
      }
    }

    func forceResolve() {
      if !isResolved {
        isResolved = true
        resolve(result.copy() as! NSDictionary)
      }
    }

    DHBleCommand.startDataSyncing { code, progress, data in
      if code != 0 {
        if !isResolved {
          isResolved = true
          reject("SYNC_FAILED", "Sync error code \(code)", nil)
        }
        return
      }

      if let array = data as? [Any], let first = array.first {
        hasData = true
        lastReceiveTime = Date()

        if first is DHDailyStepModel {
          result["step"] = self.convertStep(first as! DHDailyStepModel)
        } else if first is DHDailyHrModel {
          result["heartRate"] = self.convertHeartRate(first as! DHDailyHrModel)
        } else if first is DHDailySleepModel {
          result["sleep"] = self.convertSleep(first as! DHDailySleepModel)
        } else if first is DHDailyBoModel {
          result["spO2"] = self.convertSpo2(first as! DHDailyBoModel)
        }
      }
      checkPartialTimeout()
    }

    Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { timer in
      if isResolved { timer.invalidate(); return }
      checkPartialTimeout()
    }

    DispatchQueue.main.asyncAfter(deadline: .now() + maxTimeout) {
      forceResolve()
    }
  }
  
  
  private func convertStep(_ step: DHDailyStepModel) -> NSDictionary {
    let items = NSMutableArray()
    for item in step.items {
      if let dict = item as? [String: Any] {
        let newDict = NSMutableDictionary()
        newDict["index"] = dict["index"] as? NSNumber ?? NSNumber(value: dict["index"] as? Int ?? 0)
        newDict["step"] = dict["step"] as? NSNumber ?? NSNumber(value: dict["step"] as? Int ?? 0)
        newDict["calorie"] = dict["calorie"] as? NSNumber ?? NSNumber(value: dict["calorie"] as? Int ?? 0)
        newDict["distance"] = dict["distance"] as? NSNumber ?? NSNumber(value: dict["distance"] as? Double ?? 0.0)
        items.add(newDict)
      }
    }
    
    let result = NSMutableDictionary()
    result["distance"] = NSNumber(value: step.distance)
    result["calories"] = NSNumber(value: step.calorie)
    result["totalSteps"] = NSNumber(value: step.step)
    result["items"] = items
    return result
  }