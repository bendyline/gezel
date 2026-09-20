import Capacitor

final class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(GezelMobilePlugin())
    }
}
