// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniswapV3Router} from "../../src/interfaces/IUniswapV3Router.sol";

interface IReceiver {
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external
        returns (bool);
}

/// @dev Test token with open mint.
contract MockToken is ERC20 {
    constructor(string memory n) ERC20(n, n) {}

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

/// @dev Behaves like Aave's flashLoanSimple: lend, call back, pull back amount + premium.
contract MockAavePool {
    uint256 public premiumBps = 5; // 0.05%

    function setPremiumBps(uint256 b) external {
        premiumBps = b;
    }

    function flashLoanSimple(address receiver, address asset, uint256 amount, bytes calldata params, uint16) external {
        uint256 premium = (amount * premiumBps) / 10_000;
        MockToken(asset).mint(receiver, amount); // pool "has" the liquidity
        require(IReceiver(receiver).executeOperation(asset, amount, premium, msg.sender, params), "cb");
        IERC20(asset).transferFrom(receiver, address(this), amount + premium);
    }

    /// @dev Lets tests call the callback with an arbitrary initiator.
    function callbackWithInitiator(address receiver, address asset, uint256 amount, address initiator, bytes calldata p)
        external
    {
        IReceiver(receiver).executeOperation(asset, amount, 0, initiator, p);
    }
}

/// @dev Fixed-rate router. rate is scaled by 1e18: out = in * rate / 1e18. Implements both V3 and V2 ABIs.
contract MockRouter {
    mapping(address => mapping(address => uint256)) public rate;

    function setRate(address a, address b, uint256 r) external {
        rate[a][b] = r;
    }

    function _swap(address tIn, address tOut, uint256 amt, address to) internal returns (uint256 out) {
        require(rate[tIn][tOut] != 0, "no rate");
        IERC20(tIn).transferFrom(msg.sender, address(this), amt);
        out = (amt * rate[tIn][tOut]) / 1e18;
        MockToken(tOut).mint(to, out);
    }

    function exactInputSingle(IUniswapV3Router.ExactInputSingleParams calldata p) external payable returns (uint256) {
        return _swap(p.tokenIn, p.tokenOut, p.amountIn, p.recipient);
    }

    function swapExactTokensForTokens(uint256 amountIn, uint256, address[] calldata path, address to, uint256)
        external
        returns (uint256[] memory amounts)
    {
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = _swap(path[0], path[1], amountIn, to);
    }
}
