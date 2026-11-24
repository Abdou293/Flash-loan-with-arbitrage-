// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniswapV3Router} from "../../src/interfaces/IUniswapV3Router.sol";

/// @dev Test token with open mint.
contract MockToken is ERC20 {
    constructor(string memory n) ERC20(n, n) {}

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
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

interface IBalancerRecipient {
    function receiveFlashLoan(
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint256[] calldata feeAmounts,
        bytes calldata userData
    ) external;
}

/// @dev Behaves like Balancer V2 Vault.flashLoan: anyone may call it for any recipient; the recipient must
///      transfer amount + fee back before returning, otherwise the whole call reverts.
contract MockBalancerVault {
    uint256 public feeBps; // 0 like Balancer V2 on Arbitrum at the time of writing

    function setFeeBps(uint256 b) external {
        feeBps = b;
    }

    function flashLoan(address recipient, address[] memory tokens, uint256[] memory amounts, bytes memory userData)
        external
    {
        uint256[] memory fees = new uint256[](tokens.length);
        uint256[] memory before = new uint256[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            fees[i] = (amounts[i] * feeBps) / 10_000;
            MockToken(tokens[i]).mint(address(this), amounts[i]); // vault liquidity
            before[i] = IERC20(tokens[i]).balanceOf(address(this));
            IERC20(tokens[i]).transfer(recipient, amounts[i]);
        }
        IBalancerRecipient(recipient).receiveFlashLoan(tokens, amounts, fees, userData);
        for (uint256 i = 0; i < tokens.length; i++) {
            require(IERC20(tokens[i]).balanceOf(address(this)) >= before[i] + fees[i], "BAL#602"); // not repaid
        }
    }
}
