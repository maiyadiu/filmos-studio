// swift-tools-version: 6.0

import Foundation
import PackageDescription

let packageDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().path
let sourceInfoPlist = "\(packageDirectory)/App/SourceInfo.plist"

let package = Package(
    name: "FilmOSDesktop",
    platforms: [
        .macOS(.v13),
    ],
    products: [
        .library(name: "FilmOSDesktopCore", targets: ["FilmOSDesktopCore"]),
        .executable(name: "FilmOSStudioDesktop", targets: ["FilmOSStudioDesktop"]),
    ],
    targets: [
        .target(
            name: "FilmOSDesktopCore",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("Security"),
            ]
        ),
        .executableTarget(
            name: "FilmOSStudioDesktop",
            dependencies: ["FilmOSDesktopCore"],
            linkerSettings: [
                .linkedFramework("WebKit"),
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", sourceInfoPlist,
                ]),
            ]
        ),
        .testTarget(
            name: "FilmOSDesktopCoreTests",
            dependencies: ["FilmOSDesktopCore"]
        ),
    ]
)
